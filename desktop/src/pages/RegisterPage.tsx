import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RegisterPage() {
  const { accessToken, register } = useAuth();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [touched, setTouched] = useState<{ [key: string]: boolean }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (accessToken) return <Navigate to="/" replace />;

  const markTouched = (field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  // Validation logic
  const emailError = (() => {
    if (!email.trim()) return "Vui lòng nhập Email.";
    if (!EMAIL_REGEX.test(email.trim())) {
      return "Email không đúng định dạng (ví dụ: name@domain.com).";
    }
    return null;
  })();

  const passwordError = (() => {
    if (!password) return "Vui lòng nhập mật khẩu.";
    if (password.length < 6) {
      return "Mật khẩu phải chứa ít nhất 6 ký tự.";
    }
    return null;
  })();

  const confirmPasswordError = (() => {
    if (!confirmPassword) return "Vui lòng nhập lại mật khẩu xác nhận.";
    if (confirmPassword !== password) {
      return "Mật khẩu xác nhận không khớp với mật khẩu ở trên.";
    }
    return null;
  })();

  const lastNameError = !lastName.trim() ? "Vui lòng nhập Họ." : null;
  const firstNameError = !firstName.trim() ? "Vui lòng nhập Tên." : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);

    // Mark all as touched on submit attempt
    setTouched({
      lastName: true,
      firstName: true,
      email: true,
      password: true,
      confirmPassword: true,
    });

    if (lastNameError || firstNameError || emailError || passwordError || confirmPasswordError) {
      return;
    }

    setSubmitting(true);
    try {
      await register(email.trim(), password, firstName.trim(), lastName.trim());
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Đăng ký thất bại");
    } finally {
      setSubmitting(false);
    }
  }

  const showEmailError = touched.email && emailError;
  const showPasswordError = touched.password && passwordError;
  const showConfirmPasswordError = touched.confirmPassword && confirmPasswordError;
  const showLastNameError = touched.lastName && lastNameError;
  const showFirstNameError = touched.firstName && firstNameError;

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <p className="brand">AITest</p>
        <h1>Tạo tài khoản</h1>

        <div className="auth-row">
          <label>
            Họ
            <input
              type="text"
              className={showLastNameError ? "input-invalid" : ""}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              onBlur={() => markTouched("lastName")}
              placeholder="Nguyễn"
              required
            />
            {showLastNameError ? <span className="field-error">{lastNameError}</span> : null}
          </label>
          <label>
            Tên
            <input
              type="text"
              className={showFirstNameError ? "input-invalid" : ""}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              onBlur={() => markTouched("firstName")}
              placeholder="Văn A"
              required
            />
            {showFirstNameError ? <span className="field-error">{firstNameError}</span> : null}
          </label>
        </div>

        <label>
          Email
          <input
            type="email"
            className={showEmailError ? "input-invalid" : ""}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => markTouched("email")}
            placeholder="user@example.com"
            required
            autoComplete="username"
          />
          {showEmailError ? <span className="field-error">{emailError}</span> : null}
        </label>

        <label>
          Mật khẩu
          <input
            type="password"
            className={showPasswordError ? "input-invalid" : ""}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => markTouched("password")}
            placeholder="Tối thiểu 6 ký tự"
            required
            autoComplete="new-password"
          />
          {showPasswordError ? <span className="field-error">{passwordError}</span> : null}
        </label>

        <label>
          Xác nhận mật khẩu
          <input
            type="password"
            className={showConfirmPasswordError ? "input-invalid" : ""}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onBlur={() => markTouched("confirmPassword")}
            placeholder="Nhập lại mật khẩu"
            required
            autoComplete="new-password"
          />
          {showConfirmPasswordError ? (
            <span className="field-error">{confirmPasswordError}</span>
          ) : null}
        </label>

        {apiError ? <p className="error" style={{ marginTop: "12px" }}>{apiError}</p> : null}

        <button type="submit" disabled={submitting}>
          {submitting ? "Đang đăng ký…" : "Đăng ký"}
        </button>

        <p className="auth-footer">
          Đã có tài khoản? <Link to="/login">Đăng nhập</Link>
        </p>
      </form>
    </div>
  );
}
