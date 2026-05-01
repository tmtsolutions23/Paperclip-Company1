interface InboundTwimlOptions {
  streamUrl: string;
  hostMessage: string;
  fallbackMessage: string;
  consentLine: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildInboundTwiml(options: InboundTwimlOptions): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Response>",
    `<Say>${escapeXml(options.consentLine)}</Say>`,
    `<Say>${escapeXml(options.hostMessage)}</Say>`,
    "<Connect>",
    `<Stream url=\"${escapeXml(options.streamUrl)}\" track=\"inbound_track\" />`,
    "</Connect>",
    `<Say>${escapeXml(options.fallbackMessage)}</Say>`,
    "<Record maxLength=\"120\" playBeep=\"true\" trim=\"trim-silence\" />",
    "<Hangup />",
    "</Response>",
  ].join("");
}
