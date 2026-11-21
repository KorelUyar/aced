// "Claude Code on this Mac": uses the person's own Claude Code login, so no key is needed.
// Claude Code runs as a child process with every tool switched off: it gets text in and gives
// JSON out, and cannot read files or run anything, whatever a PDF says.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

// An app started from the Dock gets none of what the shell profile sets (PATH, tokens). The
// person's shell is asked once, in the background, right after launch. Nothing waits on a
// child process synchronously: that would freeze the app.
let shellEnv = null;
function readShellEnv() {
  if (shellEnv) return shellEnv;
  shellEnv = new Promise((resolve) => {
    const base = { ...process.env };
    if (process.platform === "win32") return resolve(base);
    const shell = base.SHELL && fs.existsSync(base.SHELL) ? base.SHELL : "/bin/zsh";
    const marker = "__SPURT_ENV__";
    let out = "";
    let child;
    try {
      child = spawn(shell, ["-ilc", `printf '${marker}'; command env -0`], { env: base, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(base);
    }
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(base));
    child.on("close", () => {
      clearTimeout(timer);
      const at = out.indexOf(marker);
      if (at >= 0) {
        for (const entry of out.slice(at + marker.length).split("\0")) {
          const eq = entry.indexOf("=");
          if (eq > 0) base[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
      resolve(base);
    });
  });
  return shellEnv;
}

async function environment() {
  const env = { ...(await readShellEnv()) };
  const home = os.homedir();
  env.PATH = [env.PATH, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
  // Set when this app is itself started from inside a Claude Code session; the child must not see them.
  for (const key of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_)/.test(key)) delete env[key];
  return env;
}

async function locate() {
  const env = await environment();
  const home = os.homedir();
  const candidates = [
    ...env.PATH.split(":").map((p) => path.join(p, "claude")),
    `${home}/.claude/local/claude`,
    `${home}/.npm-global/bin/claude`,
  ];
  return candidates.find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function run(exe, env, args, input, signal) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-cc-"));
    const child = spawn(exe, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(coded("provider", "Claude Code: " + e.message)));
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fs.rm(cwd, { recursive: true, force: true }, () => {});
      if (signal?.aborted) return reject(coded("cancelled"));
      resolve({ out, err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function attempt(exe, env, request, settingSources) {
  const { model, system, material, prompt, schema, effort, signal } = request;
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--model", model,
    "--effort", effort,
    "--system-prompt", system,
    "--tools", "",
    "--setting-sources", settingSources,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  const { out, err } = await run(exe, env, args, (material ? material + "\n\n" : "") + prompt, signal);
  let json;
  try {
    json = JSON.parse(out);
  } catch {
    throw coded("provider", "Claude Code: " + (out || err || "no output").trim().slice(0, 300));
  }
  if (json.is_error) {
    const message = String(json.result || "error");
    if (/not logged in|\/login/i.test(message)) throw coded("notSignedIn");
    if (/usage limit|rate limit/i.test(message)) throw coded("rateLimit");
    throw coded("provider", "Claude Code: " + message.slice(0, 300));
  }
  const u = json.usage || {};
  return {
    text: json.structured_output || json.result || "",
    usage: {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    },
  };
}

async function complete(request) {
  const exe = await locate();
  if (!exe) throw coded("noClaudeCode");
  const env = await environment();
  try {
    return await attempt(exe, env, request, "");
  } catch (err) {
    // The login may come from the person's own settings (an API key helper, for example).
    if (err.code !== "notSignedIn") throw err;
    return attempt(exe, env, request, "user");
  }
}

module.exports = { complete, locate, warm: readShellEnv };
