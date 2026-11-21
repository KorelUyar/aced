// A small JSON Schema check for what the model sends back: types, required fields, enums.
// Unknown fields are dropped instead of failing. Returns the cleaned value, or throws with
// a message the model can be shown when it is asked to try again.

function check(schema, value, where) {
  const fail = (what) => {
    throw new Error(`${where || "answer"}: ${what}`);
  };
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (value[key] === undefined || value[key] === null) {
          if ((schema.required || []).includes(key)) fail(`"${key}" is missing`);
          continue;
        }
        out[key] = check(sub, value[key], `${where ? where + "." : ""}${key}`);
      }
      return out;
    }
    case "array":
      if (!Array.isArray(value)) fail("must be a list");
      return value.map((v, i) => check(schema.items, v, `${where}[${i}]`));
    case "string":
      if (typeof value !== "string") fail("must be text");
      if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(", ")}`);
      return value;
    case "integer":
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) fail("must be a number");
      return schema.type === "integer" ? Math.round(n) : n;
    }
    case "boolean":
      if (typeof value !== "boolean") fail("must be true or false");
      return value;
    default:
      return value;
  }
}

/** Finds the JSON object in a model's text answer (some models wrap it in a code fence). */
function parse(text) {
  if (text && typeof text === "object") return text;
  const s = String(text || "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const from = s.indexOf("{");
    const to = s.lastIndexOf("}");
    if (from < 0 || to <= from) throw new Error("the answer is not JSON");
    try {
      return JSON.parse(s.slice(from, to + 1));
    } catch {
      throw new Error("the answer is not valid JSON");
    }
  }
}

const validate = (schema, value) => check(schema, value, "");

module.exports = { parse, validate };
