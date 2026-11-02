import { createServer } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";

export async function smtpCapture({ key, cert, port }) {
  const messages = [];
  const sockets = new Set();
  const secureContext = createSecureContext({
    key,
    cert,
    minVersion: "TLSv1.2",
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 localhost synthetic SMTP\r\n");
    attach(socket, false);
  });
  function attach(socket, secure) {
    let buffer = "",
      recipient = "",
      data = null;
    const receive = (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === ".") {
            messages.push({ recipient, raw: data.join("\r\n") });
            data = null;
            socket.write("250 captured locally\r\n");
          } else data.push(line.replace(/^\.\./, "."));
        } else if (/^EHLO /.test(line))
          socket.write(
            secure
              ? "250-localhost\r\n250 AUTH PLAIN\r\n"
              : "250-localhost\r\n250 STARTTLS\r\n",
          );
        else if (line === "STARTTLS" && !secure) {
          socket.write("220 start TLS\r\n");
          socket.off("data", receive);
          const tls = new TLSSocket(socket, { secureContext, isServer: true });
          tls.on("error", () => {});
          attach(tls, true);
          return;
        } else if (/^AUTH PLAIN /.test(line) && secure) {
          const credentials = Buffer.from(line.slice(11), "base64").toString();
          socket.write(
            credentials === "\u0000synthetic\u0000synthetic-smtp-password"
              ? "235 authenticated\r\n"
              : "535 rejected\r\n",
          );
        } else if (/^MAIL FROM:/.test(line) && secure)
          socket.write("250 sender accepted\r\n");
        else if (/^RCPT TO:/.test(line) && secure) {
          const address = line.match(
            /^RCPT TO:<([a-z0-9._+-]+@example\.test)>$/i,
          )?.[1];
          if (!address) socket.write("550 synthetic recipients only\r\n");
          else {
            recipient = address;
            socket.write("250 recipient accepted\r\n");
          }
        } else if (line === "DATA" && secure && recipient) {
          data = [];
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    };
    socket.on("data", receive);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
