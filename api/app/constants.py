"""Domain constants — mirror api/internal/models/models.go."""

# Job statuses
JOB_PENDING = "Pending"
JOB_QUEUED = "Queued"
JOB_PENDING_WORKER = "PendingWorker"
JOB_RUNNING = "Running"
JOB_COMPLETED = "Completed"
JOB_FAILED = "Failed"

# Providers
PROVIDER_OPENAI = "openai"
PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GEMINI = "gemini"
PROVIDER_OLLAMA = "ollama"
PROVIDER_ANTIGRAVITY = "antigravity"

# Connection status
STATUS_READY = "Ready"
STATUS_NOT_CONFIGURED = "NotConfigured"
STATUS_ERROR = "Error"
STATUS_CONNECTED = "Connected"
STATUS_DISCONNECTED = "Disconnected"

# Review lifecycle
REVIEW_DRAFT = "Draft"
REVIEW_IN_REVIEW = "InReview"
REVIEW_APPROVED = "Approved"
REVIEW_REJECTED = "Rejected"

# Execution status
EXEC_PASSED = "Passed"
EXEC_FAILED = "Failed"
EXEC_ERROR = "Error"


def normalize_provider(value: str | None) -> str | None:
    p = (value or "").strip().lower()
    if p in (PROVIDER_OPENAI, PROVIDER_ANTHROPIC, PROVIDER_GEMINI, PROVIDER_OLLAMA, PROVIDER_ANTIGRAVITY):
        return p
    if p == "claude":
        return PROVIDER_ANTHROPIC
    return None


def is_ai_ready(status: str) -> bool:
    return status in (STATUS_READY, STATUS_CONNECTED)


def can_transition_review(from_status: str, to_status: str) -> bool:
    if from_status == REVIEW_DRAFT:
        return to_status in (REVIEW_IN_REVIEW, REVIEW_APPROVED)
    if from_status == REVIEW_IN_REVIEW:
        return to_status in (REVIEW_APPROVED, REVIEW_REJECTED, REVIEW_DRAFT)
    if from_status == REVIEW_REJECTED:
        return to_status in (REVIEW_DRAFT, REVIEW_APPROVED)
    if from_status == REVIEW_APPROVED:
        return to_status == REVIEW_DRAFT
    return False
