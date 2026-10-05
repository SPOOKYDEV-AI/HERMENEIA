import type {
  PostgresMessagingRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresTenantContextPolicyRepository,
} from "../../persistence-postgres/src/context-policies.js";
import type {
  SqlExecutor,
} from "../../persistence/src/index.js";
import {
  TenantContextPolicyService,
  type TenantContextPolicyClock,
  type TenantContextPolicyIds,
} from "../../context-policy-service/src/index.js";

export interface PostgresTenantContextPolicyServiceDependencies {
  messagingRepository:
    PostgresMessagingRepository;
  policyRepository:
    PostgresTenantContextPolicyRepository;
  ids: TenantContextPolicyIds;
  clock: TenantContextPolicyClock;
  strategyVersion?: string;
}

export function createPostgresTenantContextPolicyService(
  deps:
    PostgresTenantContextPolicyServiceDependencies,
): TenantContextPolicyService<SqlExecutor> {
  return new TenantContextPolicyService<SqlExecutor>({
    transactions: deps.policyRepository,
    commands: deps.messagingRepository,
    policies: deps.policyRepository,
    ids: deps.ids,
    clock: deps.clock,
    strategyVersion: deps.strategyVersion,
  });
}
