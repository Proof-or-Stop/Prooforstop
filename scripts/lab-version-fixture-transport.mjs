// Disposable regression budgets, not production validation or audit policy.
export const LAB_VERSION_FIXTURE_CLI_TIMEOUT_MS=60000;
export const LAB_VERSION_FIXTURE_TOTAL_TIMEOUT_MS=4*LAB_VERSION_FIXTURE_CLI_TIMEOUT_MS+30000;
export function assertLabVersionFixtureTransport(result,action) {
 if(result.error?.code==='ETIMEDOUT')throw new Error(`LAB_VERSION_FIXTURE_CLI_TIMEOUT: ${action} exceeded ${LAB_VERSION_FIXTURE_CLI_TIMEOUT_MS}ms (signal=${result.signal})`);
 if(result.error||result.signal)throw new Error(`LAB_VERSION_FIXTURE_CLI_TRANSPORT: ${action}: ${String(result.error??result.signal)}`);
 return result;
}
