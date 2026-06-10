<script>
  import version from '$lib/generated/version.js';
</script>

<svelte:head>
  <title>tapedeck — record/replay middleware for the Vercel AI SDK</title>
  <meta
    name="description"
    content="Record/replay middleware for the Vercel AI SDK. Wrap your model in one line, record once against the live API, and replay deterministic, offline, stream-accurate cassettes in CI."
  />
</svelte:head>

<section class="hero">
  <div class="hero-grid">
    <div class="hero-copy">
      <span class="badge">
        <span class="dot" aria-hidden="true"></span>
        v{version} · MIT · zero runtime deps · vitest-native
      </span>
      <h1>
        Run your agent test once.<br />
        Replay it <span class="accent">forever</span>, offline.
      </h1>
      <p class="lede">
        <strong>tapedeck</strong> wraps your Vercel AI SDK model in one line. Record once
        against the live API and commit the cassette — every CI run after that is
        deterministic, offline, free, and stream-accurate.
      </p>

      <div class="cta">
        <a class="btn primary" href="/docs">Read the docs</a>
        <a class="btn ghost" href="/before-after">See before / after</a>
      </div>

      <pre class="install"><span class="prompt">$</span> pnpm add -D @nkwib/tapedeck</pre>
    </div>

    <aside class="demo">
      <div class="demo-tab">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="filename">model.ts</span>
      </div>
      <pre class="demo-code"><code><span class="kw">import</span> &lbrace; openai &rbrace; <span class="kw">from</span> <span class="str">'@ai-sdk/openai'</span>;
<span class="kw">import</span> &lbrace; wrapLanguageModel &rbrace; <span class="kw">from</span> <span class="str">'ai'</span>;
<span class="kw">import</span> &lbrace; cassetteMiddleware &rbrace; <span class="kw">from</span> <span class="str">'@nkwib/tapedeck'</span>;

<span class="kw">const</span> <span class="fn">model</span> = <span class="fn">wrapLanguageModel</span>(&lbrace;
  <span class="prop">model</span>: <span class="fn">openai</span>(<span class="str">'gpt-4o'</span>),
  <span class="prop">middleware</span>: <span class="fn">cassetteMiddleware</span>(&lbrace;
    <span class="prop">mode</span>: process.env.CASSETTE_MODE ?? <span class="str">'live'</span>,
    <span class="prop">cassetteDir</span>: <span class="str">'./cassettes'</span>,
    <span class="prop">redact</span>: [<span class="str">'apiKey'</span>, <span class="str">'authorization'</span>],
  &rbrace;),
&rbrace;);

<span class="cmt">// CASSETTE_MODE=record → hits live API, writes a cassette</span>
<span class="cmt">// CASSETTE_MODE=replay → offline, deterministic, free</span>
<span class="kw">const</span> &lbrace; text &rbrace; = <span class="kw">await</span> <span class="fn">generateText</span>(&lbrace; model, prompt &rbrace;);</code></pre>
    </aside>
  </div>
</section>

<section class="features">
  <div class="features-inner">
    <div class="feature">
      <div class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="5" cy="12" r="2.2" stroke="currentColor" stroke-width="1.5" />
          <circle cx="19" cy="12" r="2.2" stroke="currentColor" stroke-width="1.5" />
          <path d="M7 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </div>
      <h3>One-line wrap</h3>
      <p>
        <code>cassetteMiddleware</code> plugs into <code>wrapLanguageModel</code>. It normalizes
        at the SDK abstraction, so it's provider-agnostic — swap OpenAI for Anthropic and the
        cassette still replays.
      </p>
    </div>

    <div class="feature">
      <div class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 4h16v16H4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M8 9l3 3-3 3M14 15h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h3>Stream-accurate</h3>
      <p>
        Recorded stream parts replay as a genuine <code>ReadableStream</code> through the SDK's
        own <code>simulateReadableStream</code>. <code>streamText</code> and tool-call streaming
        see the exact surface they would live.
      </p>
    </div>

    <div class="feature">
      <div class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h3>Deterministic CI</h3>
      <p>
        Cassettes are keyed by a stable hash of the request. In <code>replay</code> a miss
        <strong>throws</strong> — a changed prompt or tool schema fails the test loudly instead
        of replaying stale data.
      </p>
    </div>

    <div class="feature">
      <div class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2l9 4-9 4-9-4 9-4z M3 12l9 4 9-4 M3 18l9 4 9-4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
      </div>
      <h3>Secrets never reach disk</h3>
      <p>
        Redaction is key-name based and runs <em>at record time</em>. A replayed cassette that
        still contains a value a matcher would strip throws <code>CassetteSecretError</code> —
        a committed key fails the build instead of leaking.
      </p>
    </div>

    <div class="feature">
      <div class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 12h4l3-9 4 18 3-9h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h3>Diff-clean cassettes</h3>
      <p>
        Cassettes are pretty-printed JSON designed to read in a PR. You can see exactly what the
        model returned, review it like code, and re-record with one env var when it changes.
      </p>
    </div>

    <div class="feature">
      <div class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </div>
      <h3>Calling card, not platform</h3>
      <p>
        No proxy, no infra, no hosted dashboard, no SaaS. Zero runtime dependencies beyond the
        <code>ai</code> peer. tapedeck's own tests use tapedeck — zero distraction surface.
      </p>
    </div>
  </div>
</section>

<section class="ports">
  <div class="ports-inner">
    <div class="ports-copy">
      <h2>A cassette is just JSON you can read</h2>
      <p>
        Pretty-printed, hash-addressed, and designed to diff cleanly in a PR. The request half is
        the cache key; the response half is the recorded stream parts. Commit it and your test is
        offline forever — until the request changes and the hash misses.
      </p>
      <a class="btn ghost compact" href="/docs#cassette-format">
        How the format works
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
    </div>
    <pre class="ports-code"><code><span class="cmt">// cassettes/checkout-flow.cassette.json — diff-stable.</span>
&lbrace;
  <span class="prop">"version"</span>: <span class="str">"tapedeck@0.1.0"</span>,
  <span class="prop">"hash"</span>: <span class="str">"sha256:abc123…"</span>,
  <span class="prop">"request"</span>: &lbrace; <span class="prop">"modelId"</span>: <span class="str">"gpt-4o"</span>, <span class="cmt">/* … */</span> &rbrace;,
  <span class="prop">"response"</span>: &lbrace;
    <span class="prop">"type"</span>: <span class="str">"stream"</span>,
    <span class="prop">"chunks"</span>: [
      &lbrace; <span class="prop">"type"</span>: <span class="str">"text-delta"</span>, <span class="prop">"delta"</span>: <span class="str">"I'll"</span> &rbrace;,
      &lbrace; <span class="prop">"type"</span>: <span class="str">"tool-call"</span>, <span class="prop">"toolName"</span>: <span class="str">"search"</span> &rbrace;
    ]
  &rbrace;
&rbrace;</code></pre>
  </div>
</section>

<section class="cta-band">
  <div class="cta-band-inner">
    <h2>Wrap an existing Vercel AI SDK agent in one line.</h2>
    <p>
      Read <code>mode</code> from an env var, record your suite once against the live API, and
      commit the cassettes. Flip <code>CASSETTE_MODE=replay</code> in CI — deterministic, offline,
      and free from then on.
    </p>
    <div class="cta">
      <a class="btn primary" href="/docs#quickstart">Quickstart</a>
      <a class="btn ghost" href="/decisions/middleware-not-proxy">Why middleware?</a>
      <a class="btn ghost" href="https://www.npmjs.com/package/@nkwib/tapedeck" target="_blank" rel="noopener">
        View on npm
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 17L17 7M17 7H9M17 7V15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
    </div>
  </div>
</section>

<style>
  .hero {
    padding: var(--sp-9) var(--sp-5) var(--sp-8);
    background:
      radial-gradient(circle at 80% -10%, var(--c-accent-soft), transparent 50%),
      radial-gradient(circle at 0% 100%, var(--c-bg-alt), transparent 60%),
      var(--c-bg);
    border-bottom: 1px solid var(--c-border);
  }

  .hero-grid {
    max-width: var(--wide-max);
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1.1fr 1fr;
    gap: var(--sp-7);
    align-items: center;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    color: var(--c-text-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 4px 10px;
    border-radius: 999px;
    box-shadow: var(--sh-sm);
    margin-bottom: var(--sp-5);
  }

  .badge .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    background: var(--c-good);
    border-radius: 999px;
  }

  .hero h1 {
    font-size: clamp(2.25rem, 4.5vw, var(--fs-4xl));
    line-height: 1.05;
    letter-spacing: -0.04em;
    margin-bottom: var(--sp-5);
  }

  .accent {
    color: var(--c-accent);
    font-style: italic;
    font-weight: 700;
  }

  .lede {
    font-size: var(--fs-md);
    color: var(--c-text-muted);
    max-width: 42ch;
    margin-bottom: var(--sp-6);
  }

  .lede strong {
    color: var(--c-text);
    font-weight: 600;
  }

  .cta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    margin-bottom: var(--sp-5);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0.65rem 1.1rem;
    border-radius: var(--r-md);
    font-size: var(--fs-sm);
    font-weight: 500;
    text-decoration: none;
    border: 1px solid transparent;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .btn.primary {
    background: var(--c-text);
    color: var(--c-bg);
    border-color: var(--c-text);
  }

  .btn.primary:hover {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-accent-fg);
    text-decoration: none;
  }

  .btn.ghost {
    background: transparent;
    color: var(--c-text);
    border-color: var(--c-border-strong);
  }

  .btn.ghost:hover {
    background: var(--c-bg-alt);
    text-decoration: none;
  }

  .btn.compact {
    padding: 0.5rem 0.85rem;
    font-size: var(--fs-sm);
  }

  .install {
    display: inline-block;
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    border-radius: var(--r-md);
    padding: var(--sp-2) var(--sp-4);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--c-text);
    box-shadow: var(--sh-sm);
    margin: 0;
  }

  .install .prompt {
    color: var(--c-text-subtle);
    margin-right: var(--sp-2);
    user-select: none;
  }

  .demo {
    background: var(--c-code-bg);
    border: 1px solid var(--c-border);
    border-radius: var(--r-lg);
    box-shadow: var(--sh-lg);
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }

  .demo-tab {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--c-border);
    background: var(--c-bg-alt);
    color: var(--c-text-subtle);
    font-size: var(--fs-xs);
  }

  .dots { display: inline-flex; gap: 6px; }
  .dots i { width: 10px; height: 10px; border-radius: 999px; background: var(--c-border-strong); display: inline-block; }
  .dots i:nth-child(1) { background: var(--c-accent); opacity: 0.55; }
  .dots i:nth-child(2) { background: #f59e0b; opacity: 0.55; }
  .dots i:nth-child(3) { background: var(--c-good); opacity: 0.55; }

  .filename { font-family: var(--font-mono); }

  .demo-code {
    margin: 0;
    padding: var(--sp-5);
    background: transparent;
    color: var(--c-code-text);
    overflow-x: auto;
    font-size: var(--fs-sm);
    line-height: 1.7;
    font-family: var(--font-mono);
  }

  .demo-code code { background: transparent; border: 0; padding: 0; color: inherit; font-family: var(--font-mono); font-size: inherit; }
  .demo-code .kw   { color: var(--c-code-keyword); }
  .demo-code .str  { color: var(--c-code-string); }
  .demo-code .fn   { color: var(--c-code-fn); }
  .demo-code .cmt  { color: var(--c-code-comment); font-style: italic; }
  .demo-code .prop { color: var(--c-code-prop); }
  .demo-code .err  { color: var(--c-code-deleted); display: block; margin-top: var(--sp-3); white-space: pre-wrap; }

  .features {
    padding: var(--sp-9) var(--sp-5);
  }

  .features-inner {
    max-width: var(--wide-max);
    margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-5);
  }

  .feature {
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    padding: var(--sp-5);
    border-radius: var(--r-lg);
  }

  .feature-icon {
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--c-bg-alt); border: 1px solid var(--c-border);
    border-radius: var(--r-md); color: var(--c-accent);
    margin-bottom: var(--sp-4);
  }

  .feature-icon svg { width: 18px; height: 18px; }

  .feature h3 { font-size: var(--fs-md); margin: 0 0 var(--sp-2); letter-spacing: -0.02em; }
  .feature p { color: var(--c-text-muted); margin: 0; font-size: var(--fs-sm); line-height: 1.65; }

  .ports {
    padding: var(--sp-8) var(--sp-5);
    background: var(--c-bg-alt);
    border-top: 1px solid var(--c-border);
    border-bottom: 1px solid var(--c-border);
  }

  .ports-inner {
    max-width: var(--wide-max);
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: var(--sp-7);
    align-items: center;
  }

  .ports-copy h2 { margin: 0 0 var(--sp-3); font-size: var(--fs-2xl); letter-spacing: -0.03em; }
  .ports-copy p { color: var(--c-text-muted); margin-bottom: var(--sp-5); font-size: var(--fs-md); }

  .ports-code {
    margin: 0;
    background: var(--c-code-bg);
    border: 1px solid var(--c-border);
    border-radius: var(--r-lg);
    padding: var(--sp-5);
    overflow-x: auto;
    color: var(--c-code-text);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.65;
    box-shadow: var(--sh-md);
  }

  .ports-code code { background: transparent; border: 0; padding: 0; color: inherit; font-family: var(--font-mono); }
  .ports-code .kw   { color: var(--c-code-keyword); }
  .ports-code .str  { color: var(--c-code-string); }
  .ports-code .fn   { color: var(--c-code-fn); }
  .ports-code .cmt  { color: var(--c-code-comment); font-style: italic; }
  .ports-code .prop { color: var(--c-code-prop); }

  .cta-band {
    padding: var(--sp-9) var(--sp-5);
    text-align: center;
  }

  .cta-band-inner {
    max-width: 44rem;
    margin: 0 auto;
  }

  .cta-band h2 { font-size: var(--fs-2xl); margin-bottom: var(--sp-2); letter-spacing: -0.03em; }
  .cta-band p { color: var(--c-text-muted); margin-bottom: var(--sp-5); font-size: var(--fs-md); }
  .cta-band .cta { justify-content: center; }

  @media (max-width: 960px) {
    .hero { padding: var(--sp-7) var(--sp-5) var(--sp-7); }
    .hero-grid { grid-template-columns: 1fr; gap: var(--sp-6); }
    .features-inner { grid-template-columns: 1fr 1fr; }
    .ports-inner { grid-template-columns: 1fr; }
  }

  @media (max-width: 720px) {
    .hero h1 { font-size: clamp(2rem, 8vw, 2.6rem); }
    .features-inner { grid-template-columns: 1fr; }
  }
</style>
