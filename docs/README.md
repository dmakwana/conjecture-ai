# docs

## claude-session.jsonl

The Claude Code session that built this project, exported verbatim.

| | |
|---|---|
| Session | `1a3e9f83-fd03-4681-905f-c82202882830` |
| Span | 2026-09-07 to 2026-09-19 |
| Records | 2,590 JSONL lines, 5.2 MB |
| Contents | Every prompt, reply, tool call and tool result, including the model's reasoning blocks |

It is the raw export rather than a tidied write-up, so it includes the dead ends
as well as the results: the plan that was written and then largely replaced when
the product changed shape, work that was started and undone, and each bug found
along the way with the investigation that led to it.

Two notes on reading it:

- The file is newline-delimited JSON, one record per line, not a document. `jq`
  is the comfortable way in. Records carry a `type`, and the conversation itself
  is in the `user` and `assistant` ones.
- It ends a moment before the commit that added it, since a session cannot
  contain its own conclusion.

## Published as HTML

`public/claude-code-transcript/` is the same session rendered as browsable pages, linked from the
app. The link points at `index.html` explicitly, because `next dev` serves files out of `public/`
but not directory indexes, so the bare directory URL 404s locally while working in production. Generated with
[simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts):

```bash
uvx claude-code-transcripts json docs/claude-session.jsonl -o public/claude-code-transcript
```

Re-run that after replacing the JSONL, and re-check for credentials: the generator renders whatever
the session contained. `test/transcript.test.ts` does that check on every run.

Checked before committing: no API key appears anywhere in it. The longest
`sk-`-prefixed token in the file is 21 characters, where a real Anthropic key is
over a hundred, so the handful of matches are documentation fragments rather
than credentials.
