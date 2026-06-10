<script>
  /**
   * Small SVG visualisation of the record/replay pipeline. Your code talks to
   * the wrapped model; in `record` mode the live provider's response is teed to
   * a cassette on disk, in `replay` mode the cassette is served back as a real
   * stream — the live provider is never touched.
   *
   * @type {{ highlight?: 'record' | 'replay' | null }}
   */
  let { highlight = null } = $props();

  const recAccent = $derived(highlight === 'record' ? 'var(--c-accent)' : 'currentColor');
  const repAccent = $derived(highlight === 'replay' ? 'var(--c-accent)' : 'currentColor');
</script>

<div class="flow" role="img" aria-label="Record/replay pipeline: your code through tapedeck, to the live provider or a cassette">
  <svg viewBox="0 0 380 150" width="100%" height="auto" preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="tdf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
      </marker>
      <marker id="tdf-arrow-acc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--c-accent)" />
      </marker>
    </defs>

    <!-- your code / test -->
    <g class="node">
      <rect x="8" y="55" width="78" height="40" rx="8" fill="var(--c-surface)" stroke="currentColor" stroke-width="1.6" />
      <text x="47" y="79" text-anchor="middle" font-family="var(--font-mono)" font-size="11">your test</text>
    </g>

    <!-- tapedeck middleware -->
    <g class="node accent">
      <rect x="151" y="53" width="78" height="44" rx="8" fill="var(--c-accent-soft)" stroke="var(--c-accent)" stroke-width="1.8" />
      <text x="190" y="72" text-anchor="middle" font-family="var(--font-mono)" font-size="11" font-weight="600">tapedeck</text>
      <text x="190" y="86" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--c-text-muted)">middleware</text>
    </g>

    <!-- code <-> tapedeck -->
    <line x1="86" y1="75" x2="149" y2="75" stroke="currentColor" stroke-width="1.6" marker-end="url(#tdf-arrow)" />

    <!-- live provider (record) -->
    <g class="node">
      <rect x="294" y="12" width="78" height="40" rx="8" fill="var(--c-surface)" stroke={recAccent} stroke-width={highlight === 'record' ? 1.9 : 1.6} />
      <text x="333" y="30" text-anchor="middle" font-family="var(--font-mono)" font-size="11">live API</text>
      <text x="333" y="43" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--c-text-muted)">$ · slow</text>
    </g>
    <path d="M229 64 Q280 50 292 36" fill="none" stroke={recAccent} stroke-width={highlight === 'record' ? 2.2 : 1.6} marker-end={highlight === 'record' ? 'url(#tdf-arrow-acc)' : 'url(#tdf-arrow)'} />
    <text x="300" y="68" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill={recAccent}>record</text>

    <!-- cassette (replay) -->
    <g class="node">
      <rect x="294" y="98" width="78" height="40" rx="8" fill="var(--c-surface)" stroke={repAccent} stroke-width={highlight === 'replay' ? 1.9 : 1.6} />
      <circle cx="318" cy="118" r="6" fill="none" stroke={repAccent} stroke-width="1.4" />
      <circle cx="348" cy="118" r="6" fill="none" stroke={repAccent} stroke-width="1.4" />
      <text x="333" y="134" text-anchor="middle" font-family="var(--font-mono)" font-size="8" fill="var(--c-text-muted)">cassette</text>
    </g>
    <path d="M229 86 Q280 100 292 114" fill="none" stroke={repAccent} stroke-width={highlight === 'replay' ? 2.2 : 1.6} marker-end={highlight === 'replay' ? 'url(#tdf-arrow-acc)' : 'url(#tdf-arrow)'} />
    <text x="300" y="100" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill={repAccent}>replay</text>
  </svg>
</div>

<style>
  .flow {
    color: var(--c-text-muted);
    margin: var(--sp-5) 0;
    padding: var(--sp-4) var(--sp-5);
    background: var(--c-bg-alt);
    border: 1px solid var(--c-border);
    border-radius: var(--r-md);
  }

  .node text {
    fill: var(--c-text);
  }
</style>
