#!/usr/bin/env bash
# ==============================================================================
# AITest Platform - Unified Deployment Script
# Supports: Docker Compose production, Alembic migrate, Postgres backup
# Usage:
#   ./deploy.sh                         # interactive menu
#   ./deploy.sh pull                    # git pull
#   ./deploy.sh docker                  # pull + up --build + migrate
#   ./deploy.sh migrate [docker|native]
#   ./deploy.sh backup [docker|native]
#   ./deploy.sh all                     # pull + docker deploy
# Env:
#   GIT_REMOTE   (default: origin)
#   GIT_BRANCH   (default: current branch)
#   ENV_FILE     (default: api/.env)
# ==============================================================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-api/.env}"
ENV_EXAMPLE="${ENV_EXAMPLE:-api/.env.example}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"

log_info() {
    echo -e "${CYAN}[INFO] ${NC}$1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS] ${NC}$1"
}

log_warn() {
    echo -e "${YELLOW}[WARN] ${NC}$1"
}

log_error() {
    echo -e "${RED}[ERROR] ${NC}$1"
}

print_banner() {
    echo -e "${CYAN}"
    echo "=========================================================="
    echo "   AITest Platform - Deploy Tool"
    echo "=========================================================="
    echo -e "${NC}"
}

env_value() {
    local key="$1"
    local default="${2:-}"
    local value
    value=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r" ' || true)
    if [ -z "$value" ]; then
        echo "$default"
    else
        echo "$value"
    fi
}

compose() {
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

python_bin() {
    if [ -x "$ROOT_DIR/api/.venv/bin/python" ]; then
        echo "$ROOT_DIR/api/.venv/bin/python"
    elif [ -x "$ROOT_DIR/api/.venv/Scripts/python.exe" ]; then
        echo "$ROOT_DIR/api/.venv/Scripts/python.exe"
    elif command -v python3 >/dev/null 2>&1; then
        command -v python3
    else
        command -v python
    fi
}

pull_latest_code() {
    if [ ! -d "$ROOT_DIR/.git" ] || ! command -v git >/dev/null 2>&1; then
        log_info "Not a git repository or git not found, skipping git pull."
        return 0
    fi

    log_info "Pulling latest changes from git..."
    git fetch --prune "$GIT_REMOTE" || {
        log_warn "git fetch failed, continuing with current files."
        return 0
    }

    local branch="${GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
    if [ "$branch" = "HEAD" ]; then
        log_warn "Detached HEAD — skip git pull."
        return 0
    fi

    log_info "remote=$GIT_REMOTE  branch=$branch"
    git checkout "$branch" || log_warn "git checkout $branch failed."
    if git pull --ff-only "$GIT_REMOTE" "$branch"; then
        log_success "Updated to $(git rev-parse --short HEAD) — $(git log -1 --pretty=format:'%s')"
    else
        log_warn "git pull failed (not fast-forward or dirty tree). Continuing with current files."
        git status --short || true
    fi
}

ensure_env_file() {
    log_info "Checking environment configuration ($ENV_FILE)..."
    if [ ! -f "$ENV_FILE" ]; then
        if [ -f "$ENV_EXAMPLE" ]; then
            cp "$ENV_EXAMPLE" "$ENV_FILE"
            log_success "Created $ENV_FILE from $ENV_EXAMPLE"
            log_error "Fill POSTGRES_PASSWORD, JWT_KEY, ENCRYPTION_KEY in $ENV_FILE then run again."
            exit 1
        fi
        log_error "Missing $ENV_FILE and template $ENV_EXAMPLE."
        exit 1
    fi

    if grep -qE '<SET_ME' "$ENV_FILE"; then
        log_error "$ENV_FILE still has <SET_ME…> placeholders."
        exit 1
    fi
    if ! grep -qE '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
        log_error "$ENV_FILE is missing POSTGRES_PASSWORD."
        exit 1
    fi
    if ! grep -qE '^JWT_KEY=' "$ENV_FILE"; then
        log_error "$ENV_FILE is missing JWT_KEY."
        exit 1
    fi
    if ! grep -qE '^ENCRYPTION_KEY=' "$ENV_FILE"; then
        log_error "$ENV_FILE is missing ENCRYPTION_KEY."
        exit 1
    fi

    export API_PORT
    API_PORT="$(env_value API_PORT "$(env_value PORT 8000)")"
    API_PORT="${API_PORT:-8000}"
    export POSTGRES_PORT
    POSTGRES_PORT="$(env_value POSTGRES_PORT 5433)"
    log_info "Using $ENV_FILE  (API host port=$API_PORT, Postgres host port=$POSTGRES_PORT)"
}

require_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        log_error "Docker is not installed or not in PATH."
        exit 1
    fi
    if ! docker compose version >/dev/null 2>&1; then
        log_error "Docker Compose v2 is not installed."
        exit 1
    fi
}

wait_for_api() {
    local tries=0
    local max_tries=30
    log_info "Waiting for API container to be ready..."
    while [ "$tries" -lt "$max_tries" ]; do
        if compose exec -T api python -c "print('ok')" >/dev/null 2>&1; then
            return 0
        fi
        tries=$((tries + 1))
        sleep 2
    done
    log_error "API container is not ready. Check: docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs api"
    compose ps || true
    return 1
}

deploy_docker() {
    log_info "Starting Docker container deployment..."
    require_docker
    pull_latest_code
    ensure_env_file

    log_info "Building and starting containers ($COMPOSE_FILE)..."
    compose up -d --build --remove-orphans
    wait_for_api
    migrate_db docker

    log_success "Docker deployment finished."
    echo ""
    log_info "Container status:"
    compose ps
    echo ""
    log_info "API:     http://localhost:${API_PORT}/api"
    log_info "Health:  http://localhost:${API_PORT}/health"
    log_info "Swagger: http://localhost:${API_PORT}/docs"
}

deploy_native() {
    log_info "Starting native API deployment (uvicorn on host)..."
    pull_latest_code
    ensure_env_file

    local py
    py="$(python_bin)"
    if [ -z "$py" ] || [ ! -x "$py" ] && ! command -v "$py" >/dev/null 2>&1; then
        log_error "Python is required. Create api/.venv or install Python 3.12."
        exit 1
    fi

    log_info "Applying Alembic migrations (native)..."
    (cd "$ROOT_DIR/api" && "$py" -m alembic upgrade head)

    local port
    port="$(env_value PORT 8000)"
    log_info "Starting uvicorn on 0.0.0.0:${port} ..."
    log_warn "This runs in the foreground. Use Docker deploy for a daemon."
    (cd "$ROOT_DIR/api" && "$py" -m uvicorn app.main:app --host 0.0.0.0 --port "$port")
}

migrate_db() {
    local mode="${1:-}"
    ensure_env_file

    if [ -z "$mode" ]; then
        if docker ps 2>/dev/null | grep -q aitest-api; then
            mode="docker"
        else
            mode="native"
        fi
    fi

    log_info "Running Alembic migrations (target: $mode)..."

    case "$mode" in
        docker|--docker|-d)
            require_docker
            compose exec -T api alembic upgrade head
            log_success "Docker DB migration complete."
            ;;
        native|--native|-n)
            local py
            py="$(python_bin)"
            (cd "$ROOT_DIR/api" && "$py" -m alembic upgrade head)
            log_success "Native DB migration complete."
            ;;
        *)
            log_error "Unknown migrate target '$mode'. Use: docker | native"
            return 1
            ;;
    esac
}

backup_db() {
    local mode="${1:-}"
    ensure_env_file
    mkdir -p "$BACKUP_DIR"
    local ts
    ts="$(date +%Y%m%d_%H%M%S)"
    local user db
    user="$(env_value POSTGRES_USER postgres)"
    db="$(env_value POSTGRES_DB AITestDb)"

    if [ -z "$mode" ]; then
        if docker ps 2>/dev/null | grep -q aitest-postgres; then
            mode="docker"
        else
            mode="native"
        fi
    fi

    local backup_file="$BACKUP_DIR/aitest_db_${mode}_${ts}.sql"
    log_info "Creating PostgreSQL backup (target: $mode)..."

    case "$mode" in
        docker|--docker|-d)
            require_docker
            compose exec -T postgres pg_dump -U "$user" -d "$db" > "$backup_file"
            log_success "Docker DB backup saved to: $backup_file"
            ;;
        native|--native|-n)
            if ! command -v pg_dump >/dev/null 2>&1; then
                log_error "pg_dump is not installed on this host."
                return 1
            fi
            PGPASSWORD="$(env_value POSTGRES_PASSWORD)" \
                pg_dump -h "$(env_value POSTGRES_HOST localhost)" \
                -p "$(env_value POSTGRES_PORT 5433)" \
                -U "$user" -d "$db" > "$backup_file"
            log_success "Native DB backup saved to: $backup_file"
            ;;
        *)
            log_error "Unknown backup target '$mode'. Use: docker | native"
            return 1
            ;;
    esac
}

deploy_all() {
    log_info "Full deploy: pull + Docker + migrate"
    deploy_docker
}

show_menu() {
    print_banner
    echo "Select deployment operation:"
    echo "  0) Pull latest code (git pull)"
    echo "  1) Docker deployment (build + up + migrate)"
    echo "  2) Native API (alembic + uvicorn on host)"
    echo "  3) Run DB migrations (Docker)"
    echo "  4) Run DB migrations (native)"
    echo "  5) Backup PostgreSQL (Docker)"
    echo "  6) Backup PostgreSQL (native)"
    echo "  7) Full deploy (same as 1)"
    echo "  8) Exit"
    echo ""
    read -r -p "Enter choice [0-8]: " CHOICE

    case "$CHOICE" in
        0) pull_latest_code ;;
        1) deploy_docker ;;
        2) deploy_native ;;
        3) migrate_db docker ;;
        4) migrate_db native ;;
        5) backup_db docker ;;
        6) backup_db native ;;
        7) deploy_all ;;
        8) exit 0 ;;
        *) log_error "Invalid selection."; exit 1 ;;
    esac
}

print_banner

case "${1:-}" in
    pull|update)
        pull_latest_code
        ;;
    docker|--docker|-d)
        deploy_docker
        ;;
    native|--native|-n)
        deploy_native
        ;;
    migrate|--migrate|-m)
        migrate_db "${2:-}"
        ;;
    backup|--backup|-b)
        backup_db "${2:-}"
        ;;
    all|--all)
        deploy_all
        ;;
    "")
        show_menu
        ;;
    *)
        log_error "Unknown parameter: $1"
        echo "Usage: ./deploy.sh [pull|docker|native|migrate [docker|native]|backup [docker|native]|all]"
        exit 1
        ;;
esac
