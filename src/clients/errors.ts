/** The error every Phoenix client call fails with. Its message never holds a credential. */
export class PhoenixAPIError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "PhoenixAPIError";
    this.statusCode = statusCode;
  }
}
