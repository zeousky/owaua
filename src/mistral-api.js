import { assertSafeText, assertSafeValue } from './safety.js';
import { ProviderError, providerError } from './provider-error.js';

// Fixed REST routes from Mistral's official TypeScript SDK at commit
// 139fc4023b04c3336bfed18a359936ae1ceab336 (2026-10-29 audit).
// https://github.com/mistralai/client-ts/tree/139fc4023b04c3336bfed18a359936ae1ceab336/src/funcs
const endpoints = {
  agentsComplete: {"method":"POST","path":"/v1/agents/completions"},
  agentsStream: {"method":"POST","path":"/v1/agents/completions","stream":true},
  audioAgentsCreate: {"method":"POST","path":"/v1/audio/agents"},
  audioAgentsDelete: {"method":"DELETE","path":"/v1/audio/agents/{agent_id}"},
  audioAgentsGet: {"method":"GET","path":"/v1/audio/agents/{agent_id}","query":["version"]},
  audioAgentsList: {"method":"GET","path":"/v1/audio/agents","query":["page_size","page_token","search"]},
  audioAgentsListSessions: {"method":"GET","path":"/v1/audio/agents/{agent_id}/sessions","query":["page_size","page_token"]},
  audioAgentsListVersions: {"method":"GET","path":"/v1/audio/agents/{agent_id}/versions","query":["page_size","page_token"]},
  audioAgentsUpdate: {"method":"PUT","path":"/v1/audio/agents/{agent_id}"},
  audioSessionsClose: {"method":"DELETE","path":"/v1/audio/sessions/{session_id}"},
  audioSessionsCreate: {"method":"POST","path":"/v1/audio/sessions"},
  audioSessionsGet: {"method":"GET","path":"/v1/audio/sessions/{session_id}"},
  audioSpeechComplete: {"method":"POST","path":"/v1/audio/speech"},
  audioTranscriptionsComplete: {"method":"POST","path":"/v1/audio/transcriptions","multipart":true},
  audioTranscriptionsStream: {"method":"POST","path":"/v1/audio/transcriptions","multipart":true,"stream":true},
  audioVoicesCreate: {"method":"POST","path":"/v1/audio/voices"},
  audioVoicesDelete: {"method":"DELETE","path":"/v1/audio/voices/{voice_id}"},
  audioVoicesGet: {"method":"GET","path":"/v1/audio/voices/{voice_id}"},
  audioVoicesGetSampleAudio: {"method":"GET","path":"/v1/audio/voices/{voice_id}/sample"},
  audioVoicesList: {"method":"GET","path":"/v1/audio/voices","query":["limit","offset","type"]},
  audioVoicesSearch: {"method":"GET","path":"/v2/audio/voices","query":["gender","kind","language","page_size","page_token","query","type"]},
  audioVoicesUpdate: {"method":"PATCH","path":"/v1/audio/voices/{voice_id}"},
  batchJobsCancel: {"method":"POST","path":"/v1/batch/jobs/{job_id}/cancel"},
  batchJobsCreate: {"method":"POST","path":"/v1/batch/jobs"},
  batchJobsDelete: {"method":"DELETE","path":"/v1/batch/jobs/{job_id}"},
  batchJobsGet: {"method":"GET","path":"/v1/batch/jobs/{job_id}","query":["inline"]},
  batchJobsList: {"method":"GET","path":"/v1/batch/jobs","query":["agent_id","created_after","created_by_me","metadata","model","order_by","page","page_size","status"]},
  betaAgentsCreate: {"method":"POST","path":"/v1/agents"},
  betaAgentsCreateVersionAlias: {"method":"PUT","path":"/v1/agents/{agent_id}/aliases","query":["alias","version"]},
  betaAgentsDelete: {"method":"DELETE","path":"/v1/agents/{agent_id}"},
  betaAgentsDeleteVersionAlias: {"method":"DELETE","path":"/v1/agents/{agent_id}/aliases","query":["alias"]},
  betaAgentsGet: {"method":"GET","path":"/v1/agents/{agent_id}","query":["agent_version"]},
  betaAgentsGetVersion: {"method":"GET","path":"/v1/agents/{agent_id}/versions/{version}"},
  betaAgentsList: {"method":"GET","path":"/v1/agents"},
  betaAgentsListPages: {"method":"GET","path":"/v1/agents/pages"},
  betaAgentsListVersionAliases: {"method":"GET","path":"/v1/agents/{agent_id}/aliases"},
  betaAgentsListVersions: {"method":"GET","path":"/v1/agents/{agent_id}/versions","query":["page","page_size"]},
  betaAgentsUpdate: {"method":"PATCH","path":"/v1/agents/{agent_id}"},
  betaAgentsUpdateVersion: {"method":"PATCH","path":"/v1/agents/{agent_id}/version","query":["version"]},
  betaConnectorsActivateForConsumer: {"method":"POST","path":"/v1/connectors/{connector_id}/{consumer_scope}/activate"},
  betaConnectorsCallTool: {"method":"POST","path":"/v1/connectors/{connector_id_or_name}/tools/{tool_name}/call","query":["credentials_name"]},
  betaConnectorsCreate: {"method":"POST","path":"/v1/connectors"},
  betaConnectorsCreateCredentials: {"method":"POST","path":"/v1/connectors/{connector_id_or_name}/{consumer_scope}/credentials"},
  betaConnectorsDeactivateForConsumer: {"method":"POST","path":"/v1/connectors/{connector_id}/{consumer_scope}/deactivate"},
  betaConnectorsDelete: {"method":"DELETE","path":"/v1/connectors/{connector_id}"},
  betaConnectorsDeleteAllUserCredentials: {"method":"DELETE","path":"/v1/connectors/{connector_id_or_name}/user/credentials"},
  betaConnectorsDeleteCredentials: {"method":"DELETE","path":"/v1/connectors/{connector_id_or_name}/{consumer_scope}/credentials/{credentials_name}"},
  betaConnectorsGet: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}","query":["fetch_user_data"]},
  betaConnectorsGetAuthUrl: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}/auth_url","query":["app_return_url","credentials_name","credentials_title","github_installation_link","method_type"]},
  betaConnectorsGetAuthenticationMethods: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}/authentication_methods"},
  betaConnectorsList: {"method":"GET","path":"/v1/connectors","query":["cursor","page_size","query_filters"]},
  betaConnectorsListOrganizationCredentials: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}/organization/credentials","query":["auth_type","fetch_default"]},
  betaConnectorsListTools: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}/tools","query":["credentials_name","page_size","pretty","refresh"]},
  betaConnectorsListUserCredentials: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}/user/credentials","query":["auth_type","fetch_default"]},
  betaConnectorsListWorkspaceCredentials: {"method":"GET","path":"/v1/connectors/{connector_id_or_name}/workspace/credentials","query":["auth_type","fetch_default"]},
  betaConnectorsShare: {"method":"PUT","path":"/v1/connectors/{connector_id}/share"},
  betaConnectorsShareToOrganization: {"method":"PUT","path":"/v1/connectors/{connector_id}/organization/share"},
  betaConnectorsUnshare: {"method":"DELETE","path":"/v1/connectors/{connector_id}/share"},
  betaConnectorsUnshareFromOrganization: {"method":"DELETE","path":"/v1/connectors/{connector_id}/organization/share"},
  betaConnectorsUpdate: {"method":"PATCH","path":"/v1/connectors/{connector_id}"},
  betaConnectorsUpdateCredentials: {"method":"PATCH","path":"/v1/connectors/{connector_id_or_name}/{consumer_scope}/credentials"},
  betaConversationsAppend: {"method":"POST","path":"/v1/conversations/{conversation_id}"},
  betaConversationsAppendStream: {"method":"POST","path":"/v1/conversations/{conversation_id}","stream":true},
  betaConversationsDelete: {"method":"DELETE","path":"/v1/conversations/{conversation_id}"},
  betaConversationsGet: {"method":"GET","path":"/v1/conversations/{conversation_id}"},
  betaConversationsGetHistory: {"method":"GET","path":"/v1/conversations/{conversation_id}/history"},
  betaConversationsGetMessages: {"method":"GET","path":"/v1/conversations/{conversation_id}/messages"},
  betaConversationsList: {"method":"GET","path":"/v1/conversations"},
  betaConversationsRestart: {"method":"POST","path":"/v1/conversations/{conversation_id}/restart"},
  betaConversationsRestartStream: {"method":"POST","path":"/v1/conversations/{conversation_id}/restart","stream":true},
  betaConversationsStart: {"method":"POST","path":"/v1/conversations"},
  betaConversationsStartStream: {"method":"POST","path":"/v1/conversations","stream":true},
  betaLibrariesAccessesDelete: {"method":"DELETE","path":"/v1/libraries/{library_id}/share"},
  betaLibrariesAccessesList: {"method":"GET","path":"/v1/libraries/{library_id}/share"},
  betaLibrariesAccessesUpdateOrCreate: {"method":"PUT","path":"/v1/libraries/{library_id}/share"},
  betaLibrariesCreate: {"method":"POST","path":"/v1/libraries"},
  betaLibrariesDelete: {"method":"DELETE","path":"/v1/libraries/{library_id}"},
  betaLibrariesDocumentsDelete: {"method":"DELETE","path":"/v1/libraries/{library_id}/documents/{document_id}"},
  betaLibrariesDocumentsExtractedTextSignedUrl: {"method":"GET","path":"/v1/libraries/{library_id}/documents/{document_id}/extracted-text-signed-url"},
  betaLibrariesDocumentsGet: {"method":"GET","path":"/v1/libraries/{library_id}/documents/{document_id}"},
  betaLibrariesDocumentsGetSignedUrl: {"method":"GET","path":"/v1/libraries/{library_id}/documents/{document_id}/signed-url"},
  betaLibrariesDocumentsLibrariesDocumentsUpdateV1: {"method":"PUT","path":"/v1/libraries/{library_id}/documents/{document_id}"},
  betaLibrariesDocumentsList: {"method":"GET","path":"/v1/libraries/{library_id}/documents","query":["filters_attributes","page","page_size","search","sort_by","sort_order"]},
  betaLibrariesDocumentsReprocess: {"method":"POST","path":"/v1/libraries/{library_id}/documents/{document_id}/reprocess"},
  betaLibrariesDocumentsStatus: {"method":"GET","path":"/v1/libraries/{library_id}/documents/{document_id}/status"},
  betaLibrariesDocumentsTextContent: {"method":"GET","path":"/v1/libraries/{library_id}/documents/{document_id}/text_content","query":["page_end","page_start"]},
  betaLibrariesDocumentsUpdate: {"method":"PATCH","path":"/v1/libraries/{library_id}/documents/{document_id}"},
  betaLibrariesDocumentsUpload: {"method":"POST","path":"/v1/libraries/{library_id}/documents","multipart":true},
  betaLibrariesGet: {"method":"GET","path":"/v1/libraries/{library_id}"},
  betaLibrariesLibrariesUpdateV1: {"method":"PUT","path":"/v1/libraries/{library_id}"},
  betaLibrariesList: {"method":"GET","path":"/v1/libraries","query":["filter_owned_by_me","page","page_size","page_token","search"]},
  betaLibrariesUpdate: {"method":"PATCH","path":"/v1/libraries/{library_id}"},
  betaObservabilityDatasetsCreate: {"method":"POST","path":"/v1/observability/datasets"},
  betaObservabilityDatasetsCreateRecord: {"method":"POST","path":"/v1/observability/datasets/{dataset_id}/records"},
  betaObservabilityDatasetsDelete: {"method":"DELETE","path":"/v1/observability/datasets/{dataset_id}"},
  betaObservabilityDatasetsExportToJsonl: {"method":"GET","path":"/v1/observability/datasets/{dataset_id}/exports/to-jsonl"},
  betaObservabilityDatasetsFetch: {"method":"GET","path":"/v1/observability/datasets/{dataset_id}"},
  betaObservabilityDatasetsFetchTask: {"method":"GET","path":"/v1/observability/datasets/{dataset_id}/tasks/{task_id}"},
  betaObservabilityDatasetsImportFromDatasetRecords: {"method":"POST","path":"/v1/observability/datasets/{dataset_id}/imports/from-dataset"},
  betaObservabilityDatasetsImportFromFile: {"method":"POST","path":"/v1/observability/datasets/{dataset_id}/imports/from-file"},
  betaObservabilityDatasetsImportFromPlayground: {"method":"POST","path":"/v1/observability/datasets/{dataset_id}/imports/from-playground"},
  betaObservabilityDatasetsImportFromSpans: {"method":"POST","path":"/v1/observability/datasets/{dataset_id}/imports/from-spans"},
  betaObservabilityDatasetsList: {"method":"GET","path":"/v1/observability/datasets","query":["page","page_size","q"]},
  betaObservabilityDatasetsListRecords: {"method":"GET","path":"/v1/observability/datasets/{dataset_id}/records","query":["page","page_size"]},
  betaObservabilityDatasetsListTasks: {"method":"GET","path":"/v1/observability/datasets/{dataset_id}/tasks","query":["page","page_size"]},
  betaObservabilityDatasetsRecordsBulkDelete: {"method":"POST","path":"/v1/observability/dataset-records/bulk-delete"},
  betaObservabilityDatasetsRecordsDelete: {"method":"DELETE","path":"/v1/observability/dataset-records/{dataset_record_id}"},
  betaObservabilityDatasetsRecordsFetch: {"method":"GET","path":"/v1/observability/dataset-records/{dataset_record_id}"},
  betaObservabilityDatasetsRecordsJudge: {"method":"POST","path":"/v1/observability/dataset-records/{dataset_record_id}/live-judging"},
  betaObservabilityDatasetsRecordsUpdatePayload: {"method":"PUT","path":"/v1/observability/dataset-records/{dataset_record_id}/payload"},
  betaObservabilityDatasetsRecordsUpdateProperties: {"method":"PUT","path":"/v1/observability/dataset-records/{dataset_record_id}/properties"},
  betaObservabilityDatasetsUpdate: {"method":"PATCH","path":"/v1/observability/datasets/{dataset_id}"},
  betaObservabilityEvaluationsCreatePipeline: {"method":"POST","path":"/v1/observability/pipelines"},
  betaObservabilityEvaluationsDeletePipeline: {"method":"DELETE","path":"/v1/observability/pipelines/{pipeline_id}"},
  betaObservabilityEvaluationsGet: {"method":"GET","path":"/v1/observability/evaluations_v2/{evaluation_slug}"},
  betaObservabilityEvaluationsGetPipeline: {"method":"GET","path":"/v1/observability/pipelines/{pipeline_id}"},
  betaObservabilityEvaluationsList: {"method":"GET","path":"/v1/observability/projects/{project_slug}/evaluations_v2","query":["page","page_size"]},
  betaObservabilityEvaluationsListPipelines: {"method":"GET","path":"/v1/observability/pipelines","query":["enabled","page","page_size","q"]},
  betaObservabilityEvaluationsOptimizationsGet: {"method":"GET","path":"/v1/observability/optimizations/{optimization_id}"},
  betaObservabilityEvaluationsOptimizationsList: {"method":"GET","path":"/v1/observability/optimizations","query":["algorithm","evaluation","page","page_size","project","status","tags"]},
  betaObservabilityEvaluationsOptimizationsListTrials: {"method":"GET","path":"/v1/observability/optimizations/{optimization_id}/trials","query":["page","page_size"]},
  betaObservabilityEvaluationsProjectsGet: {"method":"GET","path":"/v1/observability/projects/{project_slug}"},
  betaObservabilityEvaluationsProjectsList: {"method":"GET","path":"/v1/observability/projects","query":["page","page_size","q"]},
  betaObservabilityEvaluationsRecordsGet: {"method":"GET","path":"/v1/observability/evaluation-runs_v2/{run_id}/records/{record_id}"},
  betaObservabilityEvaluationsRecordsSearch: {"method":"POST","path":"/v1/observability/evaluation-runs_v2/{run_id}/records/search","query":["page","page_size"]},
  betaObservabilityEvaluationsRunsComputeStatistics: {"method":"POST","path":"/v1/observability/evaluation-runs_v2/{run_id}/statistics/compute"},
  betaObservabilityEvaluationsRunsGet: {"method":"GET","path":"/v1/observability/evaluation-runs_v2/{run_id}"},
  betaObservabilityEvaluationsRunsGetStatistics: {"method":"GET","path":"/v1/observability/evaluation-runs_v2/{run_id}/statistics"},
  betaObservabilityEvaluationsRunsSearch: {"method":"POST","path":"/v1/observability/evaluations_v2/{evaluation_slug}/runs/search","query":["page","page_size"]},
  betaObservabilityEvaluationsRunsSearchAll: {"method":"POST","path":"/v1/observability/evaluation-runs_v2/search","query":["page","page_size"]},
  betaObservabilityEvaluationsUpdatePipeline: {"method":"PUT","path":"/v1/observability/pipelines/{pipeline_id}"},
  betaObservabilityJudgesCreate: {"method":"POST","path":"/v1/observability/judges"},
  betaObservabilityJudgesDelete: {"method":"DELETE","path":"/v1/observability/judges/{judge_id}"},
  betaObservabilityJudgesFetch: {"method":"GET","path":"/v1/observability/judges/{judge_id}"},
  betaObservabilityJudgesJudgeConversation: {"method":"POST","path":"/v1/observability/judges/{judge_id}/live-judging"},
  betaObservabilityJudgesList: {"method":"GET","path":"/v1/observability/judges","query":["model_filter","page","page_size","q","type_filter"]},
  betaObservabilityJudgesUpdate: {"method":"PUT","path":"/v1/observability/judges/{judge_id}"},
  betaObservabilityLogsFetchOptions: {"method":"GET","path":"/v1/observability/logs/fields/{field_name}/options","query":["from","to"]},
  betaObservabilityLogsList: {"method":"GET","path":"/v1/observability/logs/fields"},
  betaObservabilityLogsSearch: {"method":"POST","path":"/v1/observability/logs/search","query":["cursor","from","page_size","to"]},
  betaObservabilitySpansAggregate: {"method":"POST","path":"/v1/observability/spans/aggregate","query":["from","to"]},
  betaObservabilitySpansAggregateSpanEvaluations: {"method":"POST","path":"/v1/observability/spans/evaluations/aggregate","query":["from","to"]},
  betaObservabilitySpansFetchSpanEvalFieldOptions: {"method":"GET","path":"/v1/observability/spans/evaluations/fields/{field_name}/options","query":["from","to"]},
  betaObservabilitySpansFetchSpanFieldOptions: {"method":"GET","path":"/v1/observability/spans/fields/{field_name}/options","query":["from","to"]},
  betaObservabilitySpansListSpanEvalFields: {"method":"GET","path":"/v1/observability/spans/evaluations/fields"},
  betaObservabilitySpansListSpanFields: {"method":"GET","path":"/v1/observability/spans/fields"},
  betaObservabilitySpansSearchLatestSpanEvaluations: {"method":"POST","path":"/v1/observability/spans/evaluations/search/latest","query":["cursor","from","page_size","to"]},
  betaObservabilitySpansSearchPipelineResults: {"method":"POST","path":"/v1/observability/pipeline-results/search","query":["cursor","from","page_size","to"]},
  betaObservabilitySpansSearchSpanEvaluations: {"method":"POST","path":"/v1/observability/spans/evaluations/search","query":["cursor","from","page_size","to"]},
  betaObservabilitySpansSearchSpans: {"method":"POST","path":"/v1/observability/spans/search","query":["cursor","from","page_size","to"]},
  betaObservabilityTracesAggregate: {"method":"POST","path":"/v1/observability/traces/aggregate","query":["from","to"]},
  betaObservabilityTracesFetchOptions: {"method":"GET","path":"/v1/observability/traces/fields/{field_name}/options","query":["from","to"]},
  betaObservabilityTracesGetSpanById: {"method":"GET","path":"/v1/observability/traces/{trace_id}/spans/{span_id}","query":["from","to"]},
  betaObservabilityTracesGetTraceById: {"method":"GET","path":"/v1/observability/traces/{trace_id}"},
  betaObservabilityTracesGetTraceFields: {"method":"GET","path":"/v1/observability/traces/fields"},
  betaObservabilityTracesGetTraceSpans: {"method":"GET","path":"/v1/observability/traces/{trace_id}/spans","query":["cursor","from","page_size","to"]},
  betaObservabilityTracesSearch: {"method":"POST","path":"/v1/observability/traces/search","query":["cursor","from","page_size","to"]},
  betaPromptsCreate: {"method":"POST","path":"/v2/prompts"},
  betaPromptsCreateVersion: {"method":"POST","path":"/v2/prompts/{prompt_id}/versions"},
  betaPromptsDelete: {"method":"DELETE","path":"/v2/prompts/{prompt_id}"},
  betaPromptsGet: {"method":"GET","path":"/v2/prompts/{prompt_id}","query":["alias","fields","version"]},
  betaPromptsGetVersion: {"method":"GET","path":"/v2/prompts/{prompt_id}/versions/{version}","query":["fields"]},
  betaPromptsList: {"method":"GET","path":"/v2/prompts","query":["alias","fields","pageSize","pageToken","sort_by","sort_direction","sort.direction","sort.field"]},
  betaPromptsListVersions: {"method":"GET","path":"/v2/prompts/{prompt_id}/versions"},
  betaPromptsUpdateMetadata: {"method":"PATCH","path":"/v2/prompts/{prompt_id}"},
  betaPromptsUpdateVersionMetadata: {"method":"PATCH","path":"/v2/prompts/{prompt_id}/versions/{version}"},
  betaRagIngestionPipelineConfigurationsList: {"method":"GET","path":"/v1/rag/ingestion_pipeline_configurations"},
  betaRagIngestionPipelineConfigurationsRegister: {"method":"PUT","path":"/v1/rag/ingestion_pipeline_configurations"},
  betaRagIngestionPipelineConfigurationsUpdateRunInfo: {"method":"PUT","path":"/v1/rag/ingestion_pipeline_configurations/{id}/run_info"},
  betaRagManagedIndexesCreate: {"method":"POST","path":"/v1/context/search-indexes"},
  betaRagManagedIndexesDelete: {"method":"DELETE","path":"/v1/context/search-indexes/{index_name}"},
  betaRagManagedIndexesDeleteDocuments: {"method":"DELETE","path":"/v1/context/search-indexes/{index_name}/documents"},
  betaRagManagedIndexesGenerateIndexSummary: {"method":"POST","path":"/v1/context/search-indexes/{index_name}/summary_field/{language}","query":["force"]},
  betaRagManagedIndexesGet: {"method":"GET","path":"/v1/context/search-indexes/{index_name}"},
  betaRagManagedIndexesGetChunk: {"method":"GET","path":"/v1/context/search-indexes/{index_name}/chunks/{chunk_id}"},
  betaRagManagedIndexesGetIndexSummary: {"method":"GET","path":"/v1/context/search-indexes/{index_name}/summary_field/{language}"},
  betaRagManagedIndexesGrep: {"method":"POST","path":"/v1/context/search-indexes/{index_name}/grep"},
  betaRagManagedIndexesIngestDocuments: {"method":"POST","path":"/v1/context/search-indexes/{index_name}/documents"},
  betaRagManagedIndexesList: {"method":"GET","path":"/v1/context/search-indexes","query":["creator_id","name","page_size","page_token","status"]},
  betaRagManagedIndexesNavigate: {"method":"POST","path":"/v1/context/search-indexes/{index_name}/navigate"},
  betaRagManagedIndexesRead: {"method":"POST","path":"/v1/context/search-indexes/{index_name}/read"},
  betaRagManagedIndexesSearch: {"method":"POST","path":"/v1/context/search-indexes/{index_name}/search"},
  betaRagManagedIndexesSetIndexSummary: {"method":"PUT","path":"/v1/context/search-indexes/{index_name}/summary_field/{language}"},
  betaRagManagedIndexesUpdate: {"method":"PUT","path":"/v1/context/search-indexes/{index_name}"},
  betaRagSearchIndexesGetDeploymentSummaries: {"method":"GET","path":"/v1/rag/deployments"},
  betaRagSearchIndexesRegisterDeployment: {"method":"PUT","path":"/v1/rag/deployments"},
  betaRagSearchIndexesUnregisterDeployment: {"method":"DELETE","path":"/v1/rag/deployments/{deployment_id}"},
  betaRagSearchIndexesUpdateIndexMetrics: {"method":"PUT","path":"/v1/rag/deployments/{deployment_id}/metrics"},
  betaServiceAccountsCreate: {"method":"POST","path":"/v1/service-accounts"},
  betaServiceAccountsDelete: {"method":"DELETE","path":"/v1/service-accounts/{service_account_id}"},
  betaServiceAccountsGet: {"method":"GET","path":"/v1/service-accounts/{service_account_id}"},
  betaServiceAccountsList: {"method":"GET","path":"/v1/service-accounts","query":["include_deleted","limit","offset","order","q","workspace_id"]},
  betaServiceAccountsListAssignableRoles: {"method":"GET","path":"/v1/service-accounts/assignable-roles","query":["workspace_id"]},
  betaServiceAccountsListRoles: {"method":"GET","path":"/v1/service-accounts/{service_account_id}/roles"},
  betaServiceAccountsSetRoles: {"method":"PUT","path":"/v1/service-accounts/{service_account_id}/roles"},
  betaServiceAccountsUpdate: {"method":"PATCH","path":"/v1/service-accounts/{service_account_id}"},
  betaSkillsCreate: {"method":"POST","path":"/v2/skills"},
  betaSkillsCreateVersion: {"method":"POST","path":"/v2/skills/{skill_id}/versions"},
  betaSkillsDelete: {"method":"DELETE","path":"/v2/skills/{skill_id}"},
  betaSkillsGet: {"method":"GET","path":"/v2/skills/{skill_id}","query":["alias","fields","version"]},
  betaSkillsGetVersion: {"method":"GET","path":"/v2/skills/{skill_id}/versions/{version}","query":["fields"]},
  betaSkillsList: {"method":"GET","path":"/v2/skills","query":["alias","fields","pageSize","pageToken","sort_by","sort_direction","sort.direction","sort.field"]},
  betaSkillsListVersions: {"method":"GET","path":"/v2/skills/{skill_id}/versions"},
  betaSkillsUpdateMetadata: {"method":"PATCH","path":"/v2/skills/{skill_id}"},
  betaSkillsUpdateVersionMetadata: {"method":"PATCH","path":"/v2/skills/{skill_id}/versions/{version}"},
  betaUsersGetIdentity: {"method":"GET","path":"/v1/users/me"},
  betaUsersListOrganizations: {"method":"GET","path":"/v1/users/me/organizations","query":["limit","offset"]},
  betaUsersListWorkspaces: {"method":"GET","path":"/v1/users/me/workspaces","query":["limit","offset","organization_id"]},
  betaUsersWhoami: {"method":"GET","path":"/v1/whoami"},
  chatComplete: {"method":"POST","path":"/v1/chat/completions"},
  chatStream: {"method":"POST","path":"/v1/chat/completions","stream":true},
  classifiersClassify: {"method":"POST","path":"/v1/classifications"},
  classifiersClassifyChat: {"method":"POST","path":"/v1/chat/classifications"},
  classifiersModerate: {"method":"POST","path":"/v1/moderations"},
  classifiersModerateChat: {"method":"POST","path":"/v1/chat/moderations"},
  embeddingsCreate: {"method":"POST","path":"/v1/embeddings"},
  eventsGetStreamEvents: {"method":"GET","path":"/v1/workflows/events/stream","stream":true,"query":["activity_id","activity_name","metadata_filters","parent_workflow_exec_id","root_workflow_exec_id","scope","start_seq","stream","workflow_event_types","workflow_exec_id","workflow_name"]},
  eventsGetWorkflowEvents: {"method":"GET","path":"/v1/workflows/events/list","query":["cursor","limit","root_workflow_exec_id","workflow_exec_id","workflow_run_id"]},
  filesDelete: {"method":"DELETE","path":"/v1/files/{file_id}"},
  filesDownload: {"method":"GET","path":"/v1/files/{file_id}/content"},
  filesGetSignedUrl: {"method":"GET","path":"/v1/files/{file_id}/url","query":["expiry"]},
  filesList: {"method":"GET","path":"/v1/files","query":["include_total","mimetypes","page","page_size","purpose","sample_type","search","source"]},
  filesRetrieve: {"method":"GET","path":"/v1/files/{file_id}"},
  filesUpload: {"method":"POST","path":"/v1/files","multipart":true},
  fimComplete: {"method":"POST","path":"/v1/fim/completions"},
  fimStream: {"method":"POST","path":"/v1/fim/completions","stream":true},
  modelsArchive: {"method":"POST","path":"/v1/fine_tuning/models/{model_id}/archive"},
  modelsDelete: {"method":"DELETE","path":"/v1/models/{model_id}"},
  modelsList: {"method":"GET","path":"/v1/models","query":["model","provider"]},
  modelsRetrieve: {"method":"GET","path":"/v1/models/{model_id}"},
  modelsUnarchive: {"method":"DELETE","path":"/v1/fine_tuning/models/{model_id}/archive"},
  modelsUpdate: {"method":"PATCH","path":"/v1/fine_tuning/models/{model_id}"},
  ocrProcess: {"method":"POST","path":"/v1/ocr"},
  realtimeSessionsCreate: {"method":"POST","path":"/v1/client/sessions"},
  responsesCountInputTokens: {"method":"POST","path":"/v1/responses/input_tokens"},
  responsesCreate: {"method":"POST","path":"/v1/responses"},
  workflowsArchiveWorkflow: {"method":"PUT","path":"/v1/workflows/{workflow_identifier}/archive"},
  workflowsBulkArchiveWorkflows: {"method":"PUT","path":"/v1/workflows/archive"},
  workflowsBulkUnarchiveWorkflows: {"method":"PUT","path":"/v1/workflows/unarchive"},
  workflowsDeploymentsCreateDeployment: {"method":"POST","path":"/v1/workflows/deployments"},
  workflowsDeploymentsDeleteDeployment: {"method":"DELETE","path":"/v1/workflows/deployments/{name}"},
  workflowsDeploymentsGetDeployment: {"method":"GET","path":"/v1/workflows/deployments/{name}","query":["workflow_name"]},
  workflowsDeploymentsGetDeploymentLogs: {"method":"GET","path":"/v1/workflows/deployments/{name}/logs","query":["after","before","cursor","limit","log_type","order","worker_name","workflow_name"]},
  workflowsDeploymentsListDeploymentWorkers: {"method":"GET","path":"/v1/workflows/deployments/{name}/workers","query":["cursor","limit","worker_status"]},
  workflowsDeploymentsListDeployments: {"method":"GET","path":"/v1/workflows/deployments","query":["active_only","created_by","cursor","dockerfile_path","is_hardened","limit","location_types","order","order_by","owner","repository_url","search","workflow_name","workspace_id"]},
  workflowsDeploymentsRestartDeployment: {"method":"POST","path":"/v1/workflows/deployments/{name}/restart"},
  workflowsDeploymentsStartDeployment: {"method":"POST","path":"/v1/workflows/deployments/{name}/start"},
  workflowsDeploymentsStopDeployment: {"method":"POST","path":"/v1/workflows/deployments/{name}/stop"},
  workflowsDeploymentsStreamDeploymentLogs: {"method":"GET","path":"/v1/workflows/deployments/{name}/logs/stream","stream":true,"query":["after","last_event_id","worker_name","workflow_name"]},
  workflowsDeploymentsUnhardenDeployment: {"method":"POST","path":"/v1/workflows/deployments/{deployment_id}/unharden","query":["workspace_id"]},
  workflowsDeploymentsUpdateDeployment: {"method":"PATCH","path":"/v1/workflows/deployments/{name}"},
  workflowsExecuteWorkflow: {"method":"POST","path":"/v1/workflows/{workflow_identifier}/execute"},
  workflowsExecuteWorkflowRegistration: {"method":"POST","path":"/v1/workflows/registrations/{workflow_registration_id}/execute"},
  workflowsExecutionsBatchCancelWorkflowExecutions: {"method":"POST","path":"/v1/workflows/executions/cancel"},
  workflowsExecutionsBatchTerminateWorkflowExecutions: {"method":"POST","path":"/v1/workflows/executions/terminate"},
  workflowsExecutionsCancelWorkflowExecution: {"method":"POST","path":"/v1/workflows/executions/{execution_id}/cancel"},
  workflowsExecutionsGetWorkflowExecution: {"method":"GET","path":"/v1/workflows/executions/{execution_id}","query":["include_search_keys"]},
  workflowsExecutionsGetWorkflowExecutionHistory: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/history","query":["decode_payloads"]},
  workflowsExecutionsGetWorkflowExecutionLogs: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/logs","query":["activity_id","after","before","cursor","limit","order","run_id"]},
  workflowsExecutionsGetWorkflowExecutionTraceEvents: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/trace/events","query":["include_internal_events","merge_same_id_events"]},
  workflowsExecutionsGetWorkflowExecutionTraceInfo: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/trace/info"},
  workflowsExecutionsGetWorkflowExecutionTraceOtel: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/trace/otel"},
  workflowsExecutionsGetWorkflowExecutionTraceSummary: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/trace/summary"},
  workflowsExecutionsQueryWorkflowExecution: {"method":"POST","path":"/v1/workflows/executions/{execution_id}/queries"},
  workflowsExecutionsResetWorkflow: {"method":"POST","path":"/v1/workflows/executions/{execution_id}/reset"},
  workflowsExecutionsSignalWorkflowExecution: {"method":"POST","path":"/v1/workflows/executions/{execution_id}/signals"},
  workflowsExecutionsStream: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/stream","stream":true,"query":["event_source","last_event_id"]},
  workflowsExecutionsStreamWorkflowExecutionLogs: {"method":"GET","path":"/v1/workflows/executions/{execution_id}/logs/stream","stream":true,"query":["activity_id","after","last_event_id","run_id"]},
  workflowsExecutionsTerminateWorkflowExecution: {"method":"POST","path":"/v1/workflows/executions/{execution_id}/terminate"},
  workflowsExecutionsUpdateWorkflowExecution: {"method":"POST","path":"/v1/workflows/executions/{execution_id}/updates"},
  workflowsGetWorkflow: {"method":"GET","path":"/v1/workflows/{workflow_identifier}"},
  workflowsGetWorkflowRegistration: {"method":"GET","path":"/v1/workflows/registrations/{workflow_registration_id}","query":["include_shared","with_workflow"]},
  workflowsGetWorkflowRegistrations: {"method":"GET","path":"/v1/workflows/registrations","query":["active_only","archived","available_in_chat_assistant","cursor","include_shared","limit","task_queue","with_workflow","workflow_id","workflow_name","workflow_search"]},
  workflowsGetWorkflows: {"method":"GET","path":"/v1/workflows","query":["active_only","archived","available_in_chat_assistant","cursor","deployment_name","deployment_status","include_shared","limit","order","search","sort_by","status","tags"]},
  workflowsMetricsGetWorkflowMetrics: {"method":"GET","path":"/v1/workflows/{workflow_name}/metrics","query":["end_time","start_time"]},
  workflowsRunsGetRun: {"method":"GET","path":"/v1/workflows/runs/{run_id}"},
  workflowsRunsGetRunHistory: {"method":"GET","path":"/v1/workflows/runs/{run_id}/history","query":["decode_payloads"]},
  workflowsRunsListRuns: {"method":"GET","path":"/v1/workflows/runs","query":["deployment_name","end_time_after","end_time_before","include_internal","next_page_token","order","page_size","root_execution_id","search","search_key","sort_by","start_time_after","start_time_before","status","user_id","workflow_identifier","workflow_tags"]},
  workflowsSchedulesGetSchedule: {"method":"GET","path":"/v1/workflows/schedules/{schedule_id}"},
  workflowsSchedulesGetSchedules: {"method":"GET","path":"/v1/workflows/schedules","query":["next_page_token","page_size","search","status","user_id","workflow_name"]},
  workflowsSchedulesPauseSchedule: {"method":"POST","path":"/v1/workflows/schedules/{schedule_id}/pause"},
  workflowsSchedulesResumeSchedule: {"method":"POST","path":"/v1/workflows/schedules/{schedule_id}/resume"},
  workflowsSchedulesScheduleWorkflow: {"method":"POST","path":"/v1/workflows/schedules"},
  workflowsSchedulesTriggerSchedule: {"method":"POST","path":"/v1/workflows/schedules/{schedule_id}/trigger"},
  workflowsSchedulesUnscheduleWorkflow: {"method":"DELETE","path":"/v1/workflows/schedules/{schedule_id}"},
  workflowsSchedulesUpdateSchedule: {"method":"PATCH","path":"/v1/workflows/schedules/{schedule_id}"},
  workflowsUnarchiveWorkflow: {"method":"PUT","path":"/v1/workflows/{workflow_identifier}/unarchive"},
  workflowsUpdateWorkflow: {"method":"PUT","path":"/v1/workflows/{workflow_identifier}"},
};

const aliases = {
  'chat': 'chatComplete', 'responses': 'responsesCreate', 'tokens': 'responsesCountInputTokens',
  'conversations.start': 'betaConversationsStart', 'conversations.append': 'betaConversationsAppend',
  'search': 'betaConversationsStart', 'agents.create': 'betaAgentsCreate', 'agents.list': 'betaAgentsList',
  'models': 'modelsList', 'models.list': 'modelsList', 'ocr': 'ocrProcess',
  'embeddings': 'embeddingsCreate', 'moderate': 'classifiersModerate',
  'classify': 'classifiersClassify', 'fim': 'fimComplete', 'speech': 'audioSpeechComplete',
  'transcribe': 'audioTranscriptionsComplete', 'voices': 'audioVoicesSearch',
  'files.list': 'filesList', 'files.upload': 'filesUpload', 'files.get': 'filesRetrieve',
  'files.download': 'filesDownload', 'files.delete': 'filesDelete', 'files.url': 'filesGetSignedUrl',
  'libraries.list': 'betaLibrariesList', 'libraries.create': 'betaLibrariesCreate',
  'libraries.upload': 'betaLibrariesDocumentsUpload', 'batches.create': 'batchJobsCreate',
  'batches.list': 'batchJobsList', 'batches.get': 'batchJobsGet', 'batches.cancel': 'batchJobsCancel',
};
const chatOperations = new Set(['chatComplete', 'chatStream', 'responsesCreate',
  'responsesCountInputTokens', 'betaConversationsStart', 'betaConversationsStartStream', 'betaAgentsCreate']);
const specializedModels = { ocrProcess: 'mistral-ocr-latest', embeddingsCreate: 'mistral-embed',
  classifiersModerate: 'mistral-moderation-latest', classifiersModerateChat: 'mistral-moderation-latest',
  audioSpeechComplete: 'voxtral-mini-tts-3-0', audioTranscriptionsComplete: 'voxtral-mini-transcribe-3-0',
  audioTranscriptionsStream: 'voxtral-mini-transcribe-3-0', fimComplete: 'codestral-latest', fimStream: 'codestral-latest' };
const uploadRequired = new Set(['filesUpload', 'betaLibrariesDocumentsUpload']);
const MiB = 1024 * 1024;
const discordHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class MistralInputError extends Error {}
export { ProviderError as MistralAPIError };
export const MISTRAL_MODEL = 'mistral-large-4';
export const MISTRAL_OPERATIONS = Object.freeze(Object.keys(endpoints));
export function mistralOperations() {
  return Object.entries(endpoints).map(([operation, spec]) => ({ operation, ...spec }));
}

async function boundedBytes(response, limit, signal) {
  const stated = Number(response.headers?.get('content-length'));
  if (Number.isFinite(stated) && stated > limit) {
    await response.body?.cancel().catch(() => {});
    throw new MistralInputError('The API result exceeds the 8 MiB Discord transfer limit. Use a smaller page or provider file ID.');
  }
  if (!response.body?.getReader) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new MistralInputError('The API result exceeds the 8 MiB Discord transfer limit. Use a smaller page or provider file ID.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Credential-management endpoints remain available, but secrets returned by
// Mistral are never relayed into Discord, even to the owner.
function redact(value, depth = 0) {
  if (depth > 40) throw new MistralInputError('The API response was too deeply nested.');
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:api[_-]?key|password|secret|client_secret|access_token|refresh_token|authorization|token|credentials)$/i.test(key)
      ? 'redacted' : redact(item, depth + 1)]));
}

export class MistralAPI {
  constructor({ apiKey, model = MISTRAL_MODEL, fetchImpl = fetch, timeoutMs = 180000,
    maxResponseBytes = 8 * MiB, maxUploadBytes = 8 * MiB } = {}) {
    Object.assign(this, { apiKey, model, fetchImpl, timeoutMs, maxResponseBytes, maxUploadBytes });
  }

  async request(operation, payload = {}, { signal: callerSignal, attachment } = {}) {
    const search = operation === 'search';
    operation = aliases[operation] ?? operation;
    if (!Object.hasOwn(endpoints, operation)) throw new MistralInputError('Unknown Mistral operation. Use .mistral operations for the complete list.');
    if (!object(payload)) throw new MistralInputError('The payload must be a JSON object.');
    if (!this.apiKey) throw new MistralInputError('Mistral is not configured. Add MISTRAL_API_KEY to the bot service.');
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    signal.throwIfAborted();
    const spec = endpoints[operation], values = { ...payload };
    const path = spec.path.replace(/\{([^}]+)\}/g, (_, key) => {
      const value = values[key]; delete values[key];
      if (!['string', 'number'].includes(typeof value) || !String(value).length ||
          String(value).length > 500 || ['.', '..'].includes(String(value))) {
        throw new MistralInputError(`Include a valid ${key} in the JSON payload.`);
      }
      return encodeURIComponent(String(value));
    });
    const url = new URL(path, 'https://api.mistral.ai');
    const query = values._query ?? {};
    delete values._query;
    if (!object(query)) throw new MistralInputError('_query must be a JSON object.');
    for (const key of spec.query ?? []) if (Object.hasOwn(values, key)) { query[key] = values[key]; delete values[key]; }
    if (spec.method === 'GET') { Object.assign(query, values); for (const key of Object.keys(values)) delete values[key]; }
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
      }
    }
    let data = Object.hasOwn(values, '_body') ? values._body : values;
    if (object(data)) {
      data = { ...data };
      if (chatOperations.has(operation) && !data.model && !data.agent_id) data.model = this.model;
      if (specializedModels[operation] && !data.model) data.model = specializedModels[operation];
      if (spec.stream) data.stream = true;
      if (search) data.tools ??= [{ type: 'web_search' }];
    }
    let body;
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    if (spec.multipart) {
      if (!object(data)) throw new MistralInputError('Multipart options must be a JSON object.');
      body = new FormData();
      if (uploadRequired.has(operation) && !attachment) throw new MistralInputError('Attach the file directly to your Discord command.');
      for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined || key === 'file') continue;
        if (Array.isArray(value) && ['timestamp_granularities', 'context_bias'].includes(key)) {
          for (const item of value) body.append(key, String(item));
        } else body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      if (attachment) {
        let download;
        try { download = new URL(attachment.url); } catch {}
        if (!download || download.protocol !== 'https:' || !discordHosts.has(download.hostname) ||
            download.username || download.password || download.port && download.port !== '443') {
          throw new MistralInputError('Upload files directly through Discord.');
        }
        if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > this.maxUploadBytes) {
          throw new MistralInputError('Please keep the file under 8 MiB.');
        }
        const incoming = await this.fetchImpl(download.href, { signal, redirect: 'error' });
        if (!incoming.ok) { await incoming.body?.cancel().catch(() => {}); throw new MistralInputError('The Discord attachment could not be downloaded. Attach it again.'); }
        const bytes = await boundedBytes(incoming, this.maxUploadBytes, signal);
        const name = String(attachment.name ?? 'upload.bin').split(/[\\/]/).at(-1).replace(/[^\w .-]/g, '_').slice(0, 100) || 'upload.bin';
        body.append('file', new Blob([bytes], { type: attachment.contentType || 'application/octet-stream' }), name);
      }
    } else if (!['GET', 'HEAD'].includes(spec.method)) {
      if (attachment) throw new MistralInputError('This operation takes JSON. Use files.upload or libraries.upload for attachments.');
      body = JSON.stringify(data);
      if (Buffer.byteLength(body) > 8 * MiB) throw new MistralInputError('The request JSON exceeds 8 MiB.');
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.fetchImpl(url.href, { method: spec.method, headers, body, signal, redirect: 'error' });
    if (!response.ok) throw await providerError(response, { provider: 'mistral' });
    const bytes = await boundedBytes(response, this.maxResponseBytes, signal);
    if (!bytes.length) return { ok: true, status: response.status };
    const contentType = response.headers?.get('content-type') ?? 'application/octet-stream';
    if (contentType.includes('json') && operation !== 'filesDownload') {
      let result;
      try { result = redact(JSON.parse(bytes.toString('utf8'))); }
      catch (error) { if (error instanceof MistralInputError) throw error; throw new ProviderError(502, 'invalid_response', 'mistral'); }
      assertSafeValue(result, { secrets: [this.apiKey] });
      return result;
    }
    // Inspect textual results and exact configured secrets in binary results.
    const secrets = [this.apiKey, ...Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTHORIZATION|WEBHOOK/i.test(key)).map(([, value]) => value)];
    if (secrets.some(secret => typeof secret === 'string' && secret.length >= 8 && bytes.includes(Buffer.from(secret)))) {
      throw new ProviderError(502, 'unsafe_response', 'mistral');
    }
    if (/^(?:text\/|application\/(?:xml|javascript|x-ndjson))/.test(contentType)) {
      for (let index = 0; index < bytes.length; index += MiB) assertSafeText(bytes.subarray(Math.max(0, index - 1024), index + MiB).toString('utf8'), { secrets: [this.apiKey] });
    }
    return { bytes, contentType };
  }
}
