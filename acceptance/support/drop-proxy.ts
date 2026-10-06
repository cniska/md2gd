export type Decide = (method: string, path: string) => "drop" | "pass";

const HEAD_END = "\r\n\r\n";

class Outbox {
  private queue: Buffer[] = [];
  private ending = false;

  constructor(private readonly socket: { write(data: Buffer): number; end(): void }) {}

  send(data: Buffer): void {
    this.queue.push(data);
    this.flush();
  }

  end(): void {
    this.ending = true;
    this.flush();
  }

  flush(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next === undefined) break;
      const written = this.socket.write(next);
      if (written < next.length) {
        this.queue[0] = next.subarray(Math.max(written, 0));
        return;
      }
      this.queue.shift();
    }
    if (this.ending) this.socket.end();
  }
}

type Upstream = { outbox: Outbox; head: Buffer | undefined };
type Client = { outbox: Outbox; head: Buffer; upstream: Outbox | undefined; early: Buffer[]; dropped: boolean };

function closeHead(head: string): string {
  const [startLine = "", ...headers] = head.split("\r\n");
  const kept = headers.filter((line) => line !== "" && !/^(connection|keep-alive)\s*:/i.test(line));
  return [startLine, ...kept, "Connection: close", "", ""].join("\r\n");
}
export function startDropProxy(backendPort: number, decide: Decide): { port: number; stop: () => void } {
  const listener = Bun.listen<Client>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = {
          outbox: new Outbox(socket),
          head: Buffer.alloc(0),
          upstream: undefined,
          early: [],
          dropped: false,
        };
      },
      drain(socket) {
        socket.data.outbox.flush();
      },
      data(socket, chunk) {
        const client = socket.data;
        if (client.dropped) return;
        if (client.upstream) {
          client.upstream.send(Buffer.from(chunk));
          return;
        }
        if (client.head.includes(HEAD_END)) {
          client.early.push(Buffer.from(chunk));
          return;
        }
        client.head = Buffer.concat([client.head, Buffer.from(chunk)]);
        const text = client.head.toString("latin1");
        const end = text.indexOf(HEAD_END);
        if (end === -1) return;
        const [method = "", target = ""] = text.slice(0, text.indexOf("\r\n")).split(" ");
        if (decide(method, new URL(target, "http://fake").pathname) === "drop") {
          client.dropped = true;
          socket.end();
          return;
        }
        client.early.push(Buffer.from(closeHead(text.slice(0, end + HEAD_END.length)), "latin1"));
        client.early.push(client.head.subarray(end + HEAD_END.length));
        void Bun.connect<Upstream>({
          hostname: "127.0.0.1",
          port: backendPort,
          socket: {
            open(upstream) {
              upstream.data = { outbox: new Outbox(upstream), head: Buffer.alloc(0) };
              for (const buffered of client.early) upstream.data.outbox.send(buffered);
              client.early = [];
              client.upstream = upstream.data.outbox;
            },
            drain(upstream) {
              upstream.data.outbox.flush();
            },
            data(upstream, reply) {
              const pending = upstream.data.head;
              if (pending === undefined) {
                client.outbox.send(Buffer.from(reply));
                return;
              }
              const received = Buffer.concat([pending, Buffer.from(reply)]);
              const end = received.indexOf(HEAD_END);
              if (end === -1) {
                upstream.data.head = received;
                return;
              }
              upstream.data.head = undefined;
              const head = received.subarray(0, end + HEAD_END.length).toString("latin1");
              client.outbox.send(Buffer.from(closeHead(head), "latin1"));
              client.outbox.send(received.subarray(end + HEAD_END.length));
            },
            close() {
              client.outbox.end();
            },
          },
        });
      },
      close(socket) {
        socket.data.upstream?.end();
      },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
}
