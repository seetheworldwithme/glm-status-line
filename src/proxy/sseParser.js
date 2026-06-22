// Incremental Server-Sent Events parser. SSE bytes arrive in arbitrary chunks;
// this buffers them and emits complete events (separated by a blank line) as
// { event, data } objects. Multiple `data:` lines within one event are joined
// with "\n" per the spec. Comment lines (starting with ":") are ignored.
//
// Used by the proxy to read Anthropic-format streaming events (message_start,
// message_delta, content_block_delta, message_stop) off the GLM response stream
// without buffering it.

const EVENT_BOUNDARY = /\r?\n\r?\n/g;

export function createSseParser() {
  let buffer = "";

  return {
    // Feed a chunk; returns the complete events it produced.
    feed(chunk) {
      buffer += chunk;
      const events = [];
      let last = 0;
      EVENT_BOUNDARY.lastIndex = 0;
      let match;
      while ((match = EVENT_BOUNDARY.exec(buffer)) !== null) {
        const raw = buffer.slice(last, match.index);
        last = match.index + match[0].length;
        const evt = parseEventBlock(raw);
        if (evt) {
          events.push(evt);
        }
      }
      buffer = buffer.slice(last);
      return events;
    },

    // Flush any trailing event that lacked a final blank line.
    end() {
      const events = [];
      if (buffer.trim()) {
        const evt = parseEventBlock(buffer);
        if (evt) {
          events.push(evt);
        }
      }
      buffer = "";
      return events;
    }
  };
}

function parseEventBlock(raw) {
  const lines = raw.split(/\r?\n/);
  let event;
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join("\n") };
}
