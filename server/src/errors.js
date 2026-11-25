export class VoucherError extends Error {
  /**
   * Domain-level HTTP error with machine-readable code and client-safe message.
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "VoucherError";
    this.status = status;
    this.code = code;
    this.message = message;
  }
}

