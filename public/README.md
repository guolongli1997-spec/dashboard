# public/

This directory is served as-is by the Worker's static-assets binding.

`index.html` is **your immutable chat UI** and is deliberately not included in this
repository drop: the upgrade must not restyle it. Copy your existing file in here unchanged:

```bash
cp /path/to/your/index.html public/index.html
```

`chat.js` is the only file this project owns here. It attaches to your markup by id
(`#chatForm`, `#messageInput`, `#sendButton`, `#chatArea` / `#messages`, `#newChatButton`,
`#welcome`, `#quickPrompts`, `.prompt-card[data-prompt]`, `#fileButton`, `#fileInput`,
`#voiceButton`), and it injects the *new* pieces (header dropdown, auth modal, slide-over
panels) plus their own scoped CSS at runtime, so nothing in your `<style>` block is touched.

If you would rather ship the dropdown / auth modal / panel markup statically instead of
injected, `test/fixture/index.html` shows the exact DOM that `chat.js` builds - lift those
nodes into your page verbatim and delete the `buildMenu()` / `ensureAuthUi()` /
`ensurePanelShell()` calls in `boot()`.
