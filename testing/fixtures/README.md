# Probe Fixture Scope

The chat-history probe fixtures retain record kinds/order, user query wrappers,
assistant text and tool-call/result shapes from native Grok 1.0.13. They are
minimized, not byte-identical full captures. Native system instructions,
user-info context, personal skill/MCP inventories and encrypted reasoning were
removed by `scripts/minimize-bootstrap-fixtures.mjs` under `UPDATE_FIXTURES=1`.

They prove parser structure and ordering, not valid encrypted-state resume or
the behavior of personal integrations. Native CLI integration tests use isolated
homes or explicit opt-in and do not require these private bootstrap details.
