from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
def health():
    return {
        "status": "ok",
        "milestone": "M1",
        "stack": "python",
        "features": ["projectMeta", "contextPacket"],
    }
