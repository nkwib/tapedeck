<script>
  import Sidebar from '$lib/components/Sidebar.svelte';

  let { children } = $props();

  const sections = [
    {
      label: 'Guide',
      items: [
        { href: '/docs', label: 'Overview' },
        { href: '/docs#install', label: 'Install' },
        { href: '/docs#quickstart', label: 'Quickstart' },
        { href: '/docs#modes', label: 'Modes' },
        { href: '/docs#middleware', label: 'cassetteMiddleware' },
        { href: '/docs#streaming', label: 'Streaming' },
        { href: '/docs#cassette-format', label: 'Cassette format' },
        { href: '/docs#hash', label: 'Hash algorithm' },
        { href: '/docs#redaction', label: 'Secret redaction' },
        { href: '/docs#vitest', label: 'Vitest helper' },
        { href: '/docs#cli', label: 'CLI' },
        { href: '/docs#telemetry', label: 'Telemetry' },
        { href: '/docs#storage', label: 'Storage & edge' },
        { href: '/docs#errors', label: 'Errors' },
        { href: '/docs#roadmap', label: 'Roadmap' }
      ]
    },
    {
      label: 'Reference',
      items: [
        { href: '/api', label: 'API' },
        { href: '/compatibility', label: 'Compatibility' },
        { href: '/glossary', label: 'Glossary' },
        { href: '/changelog', label: 'Changelog' }
      ]
    },
    {
      label: 'Decisions',
      items: [
        { href: '/decisions', label: 'Overview' },
        { href: '/decisions/middleware-not-proxy', label: 'Middleware, not a proxy' },
        { href: '/decisions/miss-throws-in-ci', label: 'A miss throws in CI' },
        { href: '/decisions/redact-at-record-time', label: 'Redact at record time' },
        { href: '/decisions/vercel-ai-sdk-coupling', label: 'Vercel AI SDK coupling' }
      ]
    }
  ];
</script>

<div class="docs-shell">
  <Sidebar {sections} />
  <article class="docs-article">
    {@render children()}
  </article>
</div>

<style>
  .docs-shell {
    max-width: var(--wide-max);
    margin: 0 auto;
    padding: 0 var(--sp-5);
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    gap: var(--sp-7);
    align-items: start;
  }

  .docs-article {
    padding: var(--sp-7) 0 var(--sp-9);
    max-width: var(--content-max);
    width: 100%;
  }

  .docs-article :global(h1) {
    font-size: var(--fs-2xl);
    margin-top: 0;
  }

  .docs-article :global(h2) {
    scroll-margin-top: calc(var(--header-h) + var(--sp-4));
  }

  .docs-article :global(h2),
  .docs-article :global(h3) {
    scroll-margin-top: calc(var(--header-h) + var(--sp-4));
  }

  @media (max-width: 960px) {
    .docs-shell {
      grid-template-columns: 1fr;
      gap: 0;
    }

    .docs-article {
      padding: var(--sp-4) 0 var(--sp-7);
    }
  }
</style>
