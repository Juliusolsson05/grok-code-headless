# Native Condition Evidence

Permission-card fixtures are captured from the installed Grok TUI against a
local fixture backend, not hand-authored screen strings. The backend injects
a `run_terminal_command` call with the native captured schema into a disposable
cwd. This is a controlled tool stimulus, not a recording of model reasoning.
Capture is explicit (`UPDATE_FIXTURES=1`); ordinary tests never rewrite fixtures.
