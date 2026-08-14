function streamFailure(message) {
  return new Error(message);
}

async function writeLine(output, line) {
  if (output.destroyed || output.writableEnded) {
    throw streamFailure("JSON-RPC output is unavailable.");
  }
  if (output.write(line)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      output.removeListener("drain", onDrain);
      output.removeListener("error", onError);
      output.removeListener("close", onClose);
    };
    const settle = (result, value) => {
      cleanup();
      result(value);
    };
    const onDrain = () => settle(resolve);
    const onError = () => settle(reject, streamFailure("JSON-RPC output failed."));
    const onClose = () => settle(reject, streamFailure("JSON-RPC output closed."));
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
  });
}

export class JsonLineWriter {
  #tail = Promise.resolve();
  #failure;

  constructor(output) {
    this.output = output;
  }

  write(value) {
    const line = `${JSON.stringify(value)}\n`;
    const next = this.#tail.then(() => {
      if (this.#failure) throw this.#failure;
      return writeLine(this.output, line);
    });
    this.#tail = next.catch((error) => {
      this.#failure ??= error;
    });
    return next;
  }

  async drained() {
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }
}
