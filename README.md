# OnMind-XCR — eXpress Container Registry (ECR-like)

An eXpress Container Registry for `docker login/tag/push/pull` with tags.
Same stack/philosophy as **XPS**: **Bun 1.4 + Hono 4** locally, **Lambda Node 24** in cloud.
Runs on **`:8790`**.

- Local: **filesystem** (`XCR_DATA_DIR`, zero deps, `cat`-inspectable).
- Cloud: **S3** (`XCR_S3_BUCKET`, same key layout; `XCR_S3_ENDPOINT` for RustFS/Floci/LocalStack).
- Blobs are global by digest (express deviation from strict OCI repo isolation).

> Honest warning: v1 is single-writer, uploads buffered in memory/S3 object
> (limit ~32 MB per blob in Lambda), no GC background, no SigV4/STS.
> Suitable for labs/CI and low-risk registries.

## Quickstart

```bash
cp .env.example .env
bun install
bun run dev
curl -s http://localhost:8790/health
curl -s http://localhost:8790/v2/
bun run smoke
```

Docker:

```bash
docker build -t onmind-xcr . && docker run -p 8790:8790 -v /srv/xcr:/data onmind-xcr
```

## Docker flow

```bash
docker login localhost:8790 -u dev -p dev   # password = XCR_API_KEY (skip if empty)
docker pull hello-world:latest
docker tag hello-world:latest localhost:8790/demo/hello:v1
docker push localhost:8790/demo/hello:v1
docker rmi localhost:8790/demo/hello:v1
docker pull localhost:8790/demo/hello:v1
curl -s http://localhost:8790/v2/demo/hello/tags/list
curl -s http://localhost:8790/v2/_catalog
```

## API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/health` | `{ok, env, storage}` — always open |
| `GET` | `/v2/` | version check — always open |
| `GET` | `/v2/_catalog?n=&last=` | repo list |
| `GET` | `/v2/:name/tags/list?n=&last=` | tags |
| `GET\|HEAD` | `/v2/:name/manifests/:ref` | `:ref` = tag or `sha256:…` |
| `PUT` | `/v2/:name/manifests/:ref` | `:ref` = tag; verifies `sha256(body)` |
| `DELETE` | `/v2/:name/manifests/:ref` | `202` |
| `GET\|HEAD` | `/v2/:name/blobs/:digest` | blob |
| `POST` | `/v2/:name/blobs/uploads/` | `202` + `Location`; `?digest=` monolithic, `?mount=&from=` best-effort |
| `PATCH` | `/v2/:name/blobs/uploads/:uuid` | append chunk → `204` + `Range` |
| `PUT` | `/v2/:name/blobs/uploads/:uuid?digest=` | complete → `201` + `Docker-Content-Digest` |
| `GET` | `/v2/:name/blobs/uploads/:uuid` | status → `204` + `Range` |
| `DELETE` | `/v2/:name/blobs/uploads/:uuid` | cancel → `204` |
| `POST` | `/` + `X-Amz-Target` | ECR subset: `GetAuthorizationToken`, `Create/Describe/DeleteRepository`, `List/DescribeImages`, `BatchDeleteImage` |

Errors on `/v2/*` are OCI `{errors:[{code,message}]}`; elsewhere `{message}`.
Auth: `x-api-key` header or Basic with password = `XCR_API_KEY` (except `/health`, `GET /v2/`).

## Configuration

| Variable | Default | Use |
|---|---|---|
| `PORT` | `8790` | local http |
| `XCR_STORAGE` | `filesystem` | `filesystem` \| `s3` (typo → loud error) |
| `XCR_DATA_DIR` | `./xcr-data` | filesystem root |
| `XCR_S3_BUCKET` | — | required if `s3` |
| `XCR_S3_PREFIX` | `docker-registry/` | key prefix |
| `XCR_S3_ENDPOINT` | — | RustFS / Floci / LocalStack |
| `XCR_S3_REGION` | `us-east-1` | S3 region |
| `XCR_S3_FORCE_PATH_STYLE` | auto | path-style for compatibles |
| `XCR_API_KEY` | — (empty = open) | gate (except `/health`, `GET /v2/`) |
| `XCR_CORS_ORIGINS` | `*` | CORS allowlist |
| `XCR_ENV` | `dev` | label in `/health` |
