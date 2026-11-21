// The address of "another server": https anywhere, plain http only on this computer, where
// nobody can listen in on the material and the key.

function allowedAddress(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost"));
}

/** Is it an address at all (with its scheme)? */
function isAddress(address) {
  try {
    return Boolean(new URL(address).hostname);
  } catch {
    return false;
  }
}

/**
 * What the person typed, made into an address: "localhost:1234/v1" gets http://, a host on the
 * internet gets https://. Text that already names a scheme is left as it is.
 */
function completeAddress(text) {
  const typed = String(text).trim();
  if (!typed || /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return typed;
  const host = typed.split(/[/:?#]/)[0].toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost") || typed.startsWith("[::1]");
  return (local ? "http://" : "https://") + typed;
}

/** Scheme, host and port: what a stored key belongs to. */
function origin(address) {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
}

module.exports = { allowedAddress, completeAddress, isAddress, origin };
