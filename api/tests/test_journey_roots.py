from app.features.journey.application import roots_aligned


def test_roots_aligned_same():
    assert roots_aligned(r"d:\TestIDE", r"D:\TestIDE") is True


def test_roots_aligned_mismatch():
    assert roots_aligned(r"d:\Xlab\AITest", r"D:\TestIDE") is False


def test_roots_aligned_missing():
    assert roots_aligned(None, r"D:\TestIDE") is None
    assert roots_aligned(r"d:\TestIDE", None) is None
