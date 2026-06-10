<script>
  let { size = 28 } = $props();
</script>

<span class="logo">
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    aria-hidden="true"
    role="img"
    fill="none"
  >
    <!-- cassette shell -->
    <rect
      x="3"
      y="6"
      width="26"
      height="20"
      rx="4"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    <!-- two reels -->
    <circle cx="11" cy="16" r="3.6" stroke="currentColor" stroke-width="1.6" />
    <circle cx="21" cy="16" r="3.6" stroke="currentColor" stroke-width="1.6" />
    <circle cx="11" cy="16" r="1" fill="currentColor" />
    <circle cx="21" cy="16" r="1" fill="currentColor" />
    <!-- tape spanning the reels -->
    <line
      x1="11" y1="11.5" x2="21" y2="11.5"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
    />
  </svg>
  <span class="wordmark">tapedeck</span>
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--c-text);
    font-weight: 600;
    letter-spacing: -0.02em;
    font-size: 1.05rem;
  }

  .wordmark {
    font-family: var(--font-mono);
    font-size: 0.95rem;
  }
</style>
