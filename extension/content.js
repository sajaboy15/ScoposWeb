/*
 * Content script: the page side of the extension. It reads the page, draws the
 * pointer and runs the guide; the service worker owns state, the API key and
 * the Claude call. On every page load it asks whether a guide is running in this
 * tab and resumes it, which is how multi-page walkthroughs work.
 */
(() => {
  if (window.__scoposContent) return;
  window.__scoposContent = true;
  const S = window.Scopos;
  const send = msg => chrome.runtime.sendMessage(msg).catch(() => null);

  function startGuide(steps, index, missingDelay) {
    S.guide.start(steps, {
      index,
      missingDelay,
      onChange: ({ index: i }) => send({ type: 'guide:change', index: i }),
      onEnd: reason => send({ type: 'guide:end', reason }),
      onMissing: async (step, index) => {
        const page = S.scan();
        const res = await send({ type: 'guide:missing', step, index, page });
        if (!res || res.id == null) return null;
        const el = S.byId(res.id);
        const target = el ? S.describe(el) : null;
        if (target) send({ type: 'guide:healed', index, target });
        return target;
      },
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'ping': reply({ ok: true }); break;
      case 'scan': reply(S.scan()); break;
      case 'describe': reply(msg.ids.map(id => (id == null ? null : S.describe(S.byId(id))))); break;
      case 'guide:start': startGuide(msg.steps, msg.index || 0, msg.missingDelay); reply({ ok: true }); break;
      case 'guide:go': S.guide.go(msg.index); reply({ ok: true }); break;
      case 'guide:stop': S.guide.stop(false); reply({ ok: true }); break;
      case 'record:start':
        S.guide.stop(false);
        S.recorder.start(step => send({ type: 'record:step', step }));
        S.pointer.recording(true, { onStop: () => send({ type: 'record:stop-request' }) });
        reply({ ok: true });
        break;
      case 'explore:start': S.explore.start(exploreOpts); reply({ ok: true }); break;
      case 'explore:stop': S.explore.stop(); reply({ ok: true }); break;
      case 'record:stop':
        S.pointer.recording(false);
        reply({ steps: S.recorder.stop() });
        break;
      default: return false;
    }
    return false;
  });

  // The explorer keeps its state in the service worker, so it survives full page loads.
  const exploreOpts = {
    store: { load: async () => ((await send({ type: 'explore:load' })) || {}).st || null, save: st => send({ type: 'explore:save', st }) },
    onProgress: p => send({ type: 'explore:progress', p }),
    onDone: map => send({ type: 'explore:done', map }),
  };
  S.explore.resume(exploreOpts);

  // Resume a walkthrough that continues on this page.
  send({ type: 'resume' }).then(res => { if (res && res.steps) startGuide(res.steps, res.index, res.missingDelay); });
})();
