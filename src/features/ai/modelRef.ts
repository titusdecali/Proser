/** Normalizes a user-entered model reference into a string `ollama pull`
 *  accepts. Handles plain Ollama tags, Ollama library/namespace URLs, and
 *  Hugging Face URLs or slugs. Returns undefined when it isn't usable.
 *
 *  Examples:
 *    https://huggingface.co/bartowski/Model-GGUF      -> hf.co/bartowski/Model-GGUF
 *    huggingface.co/user/repo:Q4_K_M                  -> hf.co/user/repo:Q4_K_M
 *    https://ollama.com/library/llama3.1:70b          -> llama3.1:70b
 *    ollama.com/library/llama3.1/                     -> llama3.1
 *    https://ollama.com/some-user/some-model          -> some-user/some-model
 *    gemma4:e4b                                        -> gemma4:e4b
 */
export function normalizeModelRef(input: string): string | undefined {
  let s = (input || '').trim();
  if (!s) {
    return undefined;
  }
  // Strip pasted wrappers (quotes/angle brackets) and any URL scheme.
  s = s.replace(/^[<"'\s]+|[>"'\s]+$/g, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  // Hugging Face: (huggingface.co|hf.co)/<user>/<repo>[:quant][/...]
  const hf = /^(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/\s]+)\/([^/\s?#:]+)(?::([^/\s?#]+))?/i.exec(s);
  if (hf) {
    const [, user, repo, quant] = hf;
    return `hf.co/${user}/${repo}${quant ? ':' + quant : ''}`;
  }

  // Ollama library URL: ollama.(com|ai)/library/<model>[:tag]
  const lib = /^(?:www\.)?ollama\.(?:com|ai)\/library\/([^/\s?#]+)/i.exec(s);
  if (lib) {
    return lib[1];
  }

  // Ollama namespaced/community URL: ollama.(com|ai)/<namespace>/<model>[:tag]
  const ns = /^(?:www\.)?ollama\.(?:com|ai)\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(s);
  if (ns) {
    return `${ns[1]}/${ns[2]}`;
  }

  // Otherwise accept a plausible raw tag/ref (incl. hf.co/... and namespace/model).
  if (/^[A-Za-z0-9][\w./-]*(?::[\w.-]+)?$/.test(s)) {
    return s;
  }
  return undefined;
}
