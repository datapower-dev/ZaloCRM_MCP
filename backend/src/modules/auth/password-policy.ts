/**
 * password-policy.ts — minimum password requirements shared by setup,
 * user creation and password reset.
 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const COMMON = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123',
  'admin123', 'abc12345', '11111111', '00000000', 'matkhau1', 'matkhau123',
]);

/** Returns an error message (Vietnamese) or null when the password is acceptable. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Mật khẩu không hợp lệ';
  if (password.length < MIN_LENGTH) return `Mật khẩu tối thiểu ${MIN_LENGTH} ký tự`;
  if (password.length > MAX_LENGTH) return `Mật khẩu tối đa ${MAX_LENGTH} ký tự`;
  if (COMMON.has(password.toLowerCase())) return 'Mật khẩu quá phổ biến, hãy chọn mật khẩu khác';
  const hasLetter = /[A-Za-zÀ-ỹ]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) return 'Mật khẩu phải có cả chữ và số';
  return null;
}
