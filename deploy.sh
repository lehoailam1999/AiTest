#!/usr/bin/env bash
# ==============================================================================
# AITest Platform - Auto Deployment Script (Production Docker Compose)
# Usage:
#   ./deploy.sh              # pull code mới nhất + build + migrate
#   SKIP_GIT_PULL=1 ./deploy.sh   # bỏ qua git pull
# Env:
#   GIT_REMOTE  (mặc định: origin)
#   GIT_BRANCH  (mặc định: branch hiện tại)
#   ENV_FILE    (mặc định: api/.env)
# ==============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.production.yml"
ENV_FILE="${ENV_FILE:-api/.env}"
ENV_EXAMPLE="${ENV_EXAMPLE:-api/.env.example}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"

echo "======================================================================"
echo " 🚀 BẮT ĐẦU TRIỂN KHAI BACKEND & DATABASE (AITEST PRODUCTION)"
echo "======================================================================"

# 0. Kéo code mới nhất từ git
if [ "$SKIP_GIT_PULL" = "1" ]; then
    echo "⏭️  0/4. Bỏ qua git pull (SKIP_GIT_PULL=1)"
elif ! command -v git >/dev/null 2>&1; then
    echo "❌ Lỗi: git chưa được cài đặt trên máy chủ này."
    exit 1
elif [ ! -d .git ]; then
    echo "❌ Lỗi: $ROOT_DIR không phải git repository. Clone repo rồi chạy lại."
    exit 1
else
    echo "📥 0/4. Kéo code mới nhất từ git..."
    git fetch --prune "$GIT_REMOTE"
    GIT_BRANCH="${GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
    if [ "$GIT_BRANCH" = "HEAD" ]; then
        echo "❌ Lỗi: đang ở detached HEAD. Checkout một branch rồi chạy lại."
        exit 1
    fi
    echo "  remote=$GIT_REMOTE  branch=$GIT_BRANCH"
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "❌ Working tree chưa clean. Commit/stash thay đổi trên server rồi chạy lại."
        git status --short
        exit 1
    fi
    git checkout "$GIT_BRANCH"
    git pull --ff-only "$GIT_REMOTE" "$GIT_BRANCH"
    echo "  commit=$(git rev-parse --short HEAD)  $(git log -1 --pretty=format:'%s')"
fi

# 1. Kiểm tra Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    echo "❌ Lỗi: Docker chưa được cài đặt trên máy chủ này."
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo "❌ Lỗi: Docker Compose (v2) chưa được cài đặt."
    exit 1
fi

# 2. Kiểm tra tệp env (mặc định: api/.env)
if [ ! -f "$ENV_FILE" ]; then
    echo "⚠️  Cảnh báo: Không tìm thấy tệp $ENV_FILE!"
    if [ -f "$ENV_EXAMPLE" ]; then
        echo "💡 Tự động tạo $ENV_FILE từ $ENV_EXAMPLE..."
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        echo "❌ Đã tạo $ENV_FILE từ mẫu. Điền đủ DATABASE_URL/JWT_KEY/ENCRYPTION_KEY (và POSTGRES_* nếu cần) rồi chạy lại."
        exit 1
    else
        echo "❌ Lỗi: Không tìm thấy tệp mẫu $ENV_EXAMPLE."
        exit 1
    fi
fi

if grep -qE '<SET_ME' "$ENV_FILE"; then
    echo "❌ $ENV_FILE còn placeholder <SET_ME…>. Điền secret thật trước khi deploy."
    exit 1
fi

API_PORT=$(grep -E '^(API_PORT|PORT)=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r" ' || true)
API_PORT=${API_PORT:-8000}
POSTGRES_PORT=$(grep -E '^POSTGRES_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r" ' || true)
export POSTGRES_PORT="${POSTGRES_PORT:-5433}"

# Compose production expects some variables which may not exist in api/.env.
# Fill from DATABASE_URL when possible for backward compatibility.
if ! grep -qE '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
    DB_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    DB_PASS=$(echo "$DB_URL" | sed -n 's/.*password=\([^ ]*\).*/\1/p')
    export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-${DB_PASS:-postgres}}"
fi
if ! grep -qE '^POSTGRES_USER=' "$ENV_FILE"; then
    DB_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    DB_USER=$(echo "$DB_URL" | sed -n 's/.*user=\([^ ]*\).*/\1/p')
    export POSTGRES_USER="${POSTGRES_USER:-${DB_USER:-postgres}}"
fi
if ! grep -qE '^POSTGRES_DB=' "$ENV_FILE"; then
    DB_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    DB_NAME=$(echo "$DB_URL" | sed -n 's/.*dbname=\([^ ]*\).*/\1/p')
    export POSTGRES_DB="${POSTGRES_DB:-${DB_NAME:-AITestDb}}"
fi

export API_PORT
echo "  env: $ENV_FILE  (API container DB = postgres:5432, host port = ${POSTGRES_PORT:-5433})"

# 3. Khởi chạy Containers
echo "📦 2/4. Khởi chạy Containers bằng $COMPOSE_FILE..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans

# 4. Chạy Alembic Migration CSDL
echo "🗄️  3/4. Thực thi Alembic DB Migrations..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T api alembic upgrade head

# 5. Kiểm tra trạng thái Services
echo "🔍 4/4. Kiểm tra trạng thái các Container Services..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps

echo "======================================================================"
echo " 🎉 TRIỂN KHAI HOÀN TẤT THÀNH CÔNG!"
echo " 🌐 API Server Endpoint: http://localhost:${API_PORT}/api"
echo "======================================================================"
