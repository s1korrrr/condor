# Research graph browser fixture

From `frontend/`, run:

```bash
./node_modules/.bin/vite --config test/browser/research/vite.config.mjs
```

Open `http://127.0.0.1:18191/research?view=graph`. The fixture renders the
real `Research` page and graph component. Its local middleware supplies a
three-node Research OS envelope and accepts only the dummy
`Bearer fixture-token` added by the page's normal `authFetch` helper. Read
`http://127.0.0.1:18191/__fixture/requests` to inspect requested endpoints,
server identity and whether the dummy token was present.

Check the default dependency topology, switch to all indexed nodes, search
for and select “Hidden report,” then switch back to dependencies. The report
must remain selected with an explicit hidden-by-topology message and its
evidence inspector. The fixture has no live Research OS or trading connection.
