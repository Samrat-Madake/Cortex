# lmms-eval Integration Layer

This directory contains ReflectWorld's custom backend and integration notes for `lmms-eval`.

Current backend:

```text
memory_api/
```

The backend registers this lmms-eval model name:

```text
memory_api
```

After installation, `lmms-eval` converts each question into an HTTP request to the ReflectWorld `eval-server.ts`.
