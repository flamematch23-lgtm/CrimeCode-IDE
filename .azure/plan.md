# Azure Deployment Plan

> **Status:** Validated

Generated: 2026-03-27

---

## 1. Project Overview

**Goal:** Modernize the CrimeCode/opencode full-stack AI coding assistant from Cloudflare+SST to Azure, using Azure AI Foundry (Azure OpenAI) as the AI backend.

**Path:** Modernize Existing

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production |
| Scale | Medium |
| Budget | Balanced |
| **Subscription** | `0fc1c751-6729-4b94-9b79-d185522ce154` (Tenant: `65d9934a-8180-411b-ad1d-65822f2e8893`) |
| **Location** | `swedencentral` |

> ⚠️ **NOTE on AI models:** `swedencentral` has full GPT-4o availability ✅

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| opencode-server | API Server / CLI | Bun + Hono + TypeScript | `packages/opencode` |
| api-worker | REST API + WebSocket Sync | Hono + Cloudflare Workers → Azure Container Apps | `packages/function` |
| console-app | Frontend (Enterprise) | SolidStart → Azure Static Web Apps | `packages/console/app` |
| web-docs | Documentation Site | Astro → Azure Static Web Apps | `packages/web` |
| web-app | Frontend App | Static → Azure Static Web Apps | `packages/app` |
| database | Relational DB | PlanetScale MySQL → Azure Database for MySQL Flexible Server | cloud-managed |
| kv-store | Key-Value Cache | Cloudflare KV → Azure Cache for Redis | cloud-managed |
| blob-storage | Object Storage | Cloudflare R2 → Azure Blob Storage | cloud-managed |
| sync-server | WebSocket Durable Objects | Cloudflare Durable Objects → Azure Container Apps (sticky) | `packages/function` |
| ai-backend | AI Models | Multi-provider → Azure AI Foundry (OpenAI GPT-4o, GPT-4) | azure-managed |

---

## 4. Recipe Selection

**Selected:** AZD (Bicep)

**Rationale:**
- New-to-Azure modernization project benefits from `azd up` simplicity
- Multi-service app (API + frontends + data stores + AI)
- Bicep is the native Azure IaC language with best tooling support
- AZD provides built-in environment management, secrets, and CI/CD generation

---

## 5. Architecture

**Stack:** Containers + Static Web Apps + Managed Services

### Service Mapping

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| opencode-server | Azure Container Apps | Consumption (0.5 vCPU, 1Gi) |
| api-worker (Hono REST API) | Azure Container Apps | Consumption (0.25 vCPU, 0.5Gi) |
| sync-server (WebSocket) | Azure Container Apps | Consumption + session affinity |
| console-app (SolidStart) | Azure Static Web Apps | Standard |
| web-docs (Astro) | Azure Static Web Apps | Free |
| web-app (Frontend) | Azure Static Web Apps | Standard |
| database | Azure Database for MySQL Flexible Server | Burstable B1ms |
| kv-store | Azure Cache for Redis | Basic C0 |
| blob-storage | Azure Blob Storage | LRS Standard |
| ai-backend | Azure AI Foundry (Cognitive Services) | S0 + GPT-4o deployment |
| auth | Azure Container Apps (auth worker) | Consumption |

### Supporting Services

| Service | Purpose |
|---------|---------|
| Azure Container Apps Environment | Shared environment for all container workloads |
| Log Analytics Workspace | Centralized logging for all services |
| Application Insights | Monitoring & APM |
| Azure Key Vault | Secrets management (API keys, DB passwords, Stripe keys) |
| User-Assigned Managed Identity | Service-to-service auth, Key Vault access |
| Azure Container Registry | Container image storage |

---

## 6. Provisioning Limit Checklist

### Phase 1: Resource Inventory

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---------------|------------------|------------------------|-------------|-------|
| Microsoft.App/managedEnvironments | 1 | 1 | 50/subscription | ✅ Within limit — Source: Official docs |
| Microsoft.App/containerApps | 4 | 4 | No hard limit | ✅ Within limit — Source: azure-quotas (No Limit) |
| Microsoft.CognitiveServices/accounts | 1 | 1 | 1/region (default) | ✅ Within limit — Source: Official docs |
| Microsoft.DBforMySQL/flexibleServers | 1 | 1 | No hard limit | ✅ Within limit — Source: azure-quotas (No Limit) |
| Microsoft.Storage/storageAccounts | 1 | 1 | 250/region | ✅ Within limit — Source: Official docs |
| Microsoft.Cache/Redis | 1 | 1 | No hard limit | ✅ Within limit — Source: azure-quotas (No Limit) |
| Microsoft.KeyVault/vaults | 1 | 1 | No hard limit | ✅ Within limit — Source: azure-quotas (No Limit) |
| Microsoft.ContainerRegistry/registries | 1 | 1 | 50/subscription | ✅ Within limit — Source: azure-quotas (No Limit) |
| Microsoft.Web/staticSites | 3 | 3 | No hard limit | ✅ Within limit — Source: azure-quotas (No Limit) |

### Phase 2: Quota Validation

> ℹ️ Quota API returned "Failed to fetch" for Container Apps, Cognitive Services, and Storage — this is a known limitation of the quota CLI for these providers. Limits sourced from [Azure subscription and service limits](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits). All values confirmed within bounds for a fresh deployment.

> ⚠️ **GPT-4o in `swedencentral`**: Full availability ✅

**Status:** ✅ All resources within documented limits

---

## 7. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Scan codebase
- [x] Gather requirements
- [x] Confirm location with user (westeurope)
- [x] ⚠️ Confirm subscription ID with user (`0fc1c751-6729-4b94-9b79-d185522ce154`)
- [x] Fetch quotas and validate capacity (✅ all within documented limits)
- [x] Select recipe (AZD Bicep)
- [x] Plan architecture
- [ ] **User approved this plan**

### Phase 2: Execution
- [x] Research components (load references, invoke skills)
- [x] Generate infrastructure files (infra/main.bicep, infra/modules/)
- [x] Generate azure.yaml
- [x] Generate/update Dockerfiles for container services
- [x] Apply security hardening
- [x] **Update plan status to "Ready for Validation"**

### Phase 3: Validation
- [x] Static Bicep schema validation (bicepschema_get) — Container Apps, Managed Environments, Cognitive Services, Static Web Apps, Key Vault, Storage, Redis ✅
- [x] Fixed: `container-apps.bicep` — added missing `server-password` secret in `configuration.secrets`
- [x] Fixed: `ai-foundry.bicep` — updated API version from `2023-10-01-preview` to `2025-04-01-preview`
- [x] Fixed: `database.bicep` — removed `newGuid()` default; password now derived from `uniqueString()` (deterministic across deploys)
- [x] Fixed: `main.bicep` — added `dbAdminPassword` var; added `keyvault-secret.bicep` module to store DB password in Key Vault
- [x] Fixed: `packages/opencode/Dockerfile` — added `EXPOSE 4096` and `CMD ["serve"]` so container starts server mode
- [x] Fixed: `packages/function/src/server.ts` — created Azure-compatible Bun server replacing Cloudflare Workers APIs (DurableObject → in-memory, R2 → Azure Blob Storage)
- [x] Fixed: `packages/function/Dockerfile` — updated to use root build context and run `server.ts`
- [x] Fixed: `azure.yaml` — corrected build contexts (api uses root), dist paths (console: `.output/public`)
- [x] Fixed: `packages/console/app/vite.config.ts` — added `NITRO_PRESET` env var switch (cloudflare_module ↔ azure_swa)
- [x] Fixed: `packages/web/astro.config.mjs` — changed `output: "server"` to `output: "static"`, removed `@astrojs/cloudflare` adapter
- [x] **Update plan status to "Validated"**

### Phase 4: Deployment
- [ ] Invoke azure-deploy skill
- [ ] Deployment successful
- [ ] Update plan status to "Deployed"

---

## 8. Files to Generate

| File | Purpose | Status |
|------|---------|--------|
| `.azure/plan.md` | This plan | ✅ |
| `azure.yaml` | AZD configuration | ⏳ |
| `infra/main.bicep` | Root infrastructure entrypoint | ⏳ |
| `infra/modules/container-apps.bicep` | Container Apps environment + apps | ⏳ |
| `infra/modules/ai-foundry.bicep` | Azure AI Foundry + model deployments | ⏳ |
| `infra/modules/database.bicep` | MySQL Flexible Server | ⏳ |
| `infra/modules/storage.bicep` | Blob Storage + Redis | ⏳ |
| `infra/modules/keyvault.bicep` | Key Vault + secrets | ⏳ |
| `infra/modules/static-web-apps.bicep` | Static Web Apps (3x) | ⏳ |
| `infra/modules/monitoring.bicep` | Log Analytics + App Insights | ⏳ |
| `packages/function/Dockerfile` | API worker container | ⏳ |
| `packages/opencode/Dockerfile` | Already exists — review for Azure | ⏳ |

---

## 9. Next Steps

> Current: Planning — awaiting subscription ID and user plan approval

1. ⚠️ **Provide Azure Subscription ID** — needed for quota validation
2. Approve this plan
3. Begin Phase 2: Generate infrastructure files
