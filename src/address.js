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

/** Scheme, host and port: what a stored key belongs to. */
function origin(address) {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
}

module.exports = { allowedAddress, origin };
