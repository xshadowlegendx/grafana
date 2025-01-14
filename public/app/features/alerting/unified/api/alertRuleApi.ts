import { set } from 'lodash';

import { RelativeTimeRange } from '@grafana/data';
import { Matcher } from 'app/plugins/datasource/alertmanager/types';
import { RuleIdentifier, RuleNamespace, RulerDataSourceConfig } from 'app/types/unified-alerting';
import {
  AlertQuery,
  Annotations,
  GrafanaAlertStateDecision,
  Labels,
  PostableRulerRuleGroupDTO,
  PromRulesResponse,
  RulerGrafanaRuleDTO,
  RulerRuleGroupDTO,
  RulerRulesConfigDTO,
} from 'app/types/unified-alerting-dto';

import { ExportFormats } from '../components/export/providers';
import { Folder } from '../components/rule-editor/RuleFolderPicker';
import { getDatasourceAPIUid, GRAFANA_RULES_SOURCE_NAME, isGrafanaRulesSource } from '../utils/datasource';
import { arrayKeyValuesToObject } from '../utils/labels';
import { isCloudRuleIdentifier, isPrometheusRuleIdentifier } from '../utils/rules';

import { alertingApi } from './alertingApi';
import {
  FetchPromRulesFilter,
  groupRulesByFileName,
  paramsWithMatcherAndState,
  prepareRulesFilterQueryParams,
} from './prometheus';
import { FetchRulerRulesFilter, rulerUrlBuilder } from './ruler';

export type ResponseLabels = {
  labels: AlertInstances[];
};

export type PreviewResponse = ResponseLabels[];

export interface Datasource {
  type: string;
  uid: string;
}

export const PREVIEW_URL = '/api/v1/rule/test/grafana';
export const PROM_RULES_URL = 'api/prometheus/grafana/api/v1/rules';

export interface Data {
  refId: string;
  relativeTimeRange: RelativeTimeRange;
  queryType: string;
  datasourceUid: string;
  model: AlertQuery;
}

export interface GrafanaAlert {
  data?: Data;
  condition: string;
  no_data_state: GrafanaAlertStateDecision;
  title: string;
}

export interface Rule {
  grafana_alert: GrafanaAlert;
  for: string;
  labels: Labels;
  annotations: Annotations;
}

export type AlertInstances = Record<string, string>;

interface ExportRulesParams {
  format: ExportFormats;
  folderUid?: string;
  group?: string;
  ruleUid?: string;
}

export interface AlertGroupUpdated {
  message: string;
  /**
   * UIDs of rules updated from this request
   */
  updated: string[];
}

export const alertRuleApi = alertingApi.injectEndpoints({
  endpoints: (build) => ({
    preview: build.mutation<
      PreviewResponse,
      {
        alertQueries: AlertQuery[];
        condition: string;
        folder: Folder;
        customLabels: Array<{
          key: string;
          value: string;
        }>;
        alertName?: string;
        alertUid?: string;
      }
    >({
      query: ({ alertQueries, condition, customLabels, folder, alertName, alertUid }) => ({
        url: PREVIEW_URL,
        data: {
          rule: {
            grafana_alert: {
              data: alertQueries,
              condition: condition,
              no_data_state: 'Alerting',
              title: alertName,
              uid: alertUid ?? 'N/A',
            },
            for: '0s',
            labels: arrayKeyValuesToObject(customLabels),
            annotations: {},
          },
          folderUid: folder.uid,
          folderTitle: folder.title,
        },
        method: 'POST',
      }),
    }),

    prometheusRulesByNamespace: build.query<
      RuleNamespace[],
      {
        limitAlerts?: number;
        identifier?: RuleIdentifier;
        filter?: FetchPromRulesFilter;
        state?: string[];
        matcher?: Matcher[];
      }
    >({
      query: ({ limitAlerts, identifier, filter, state, matcher }) => {
        const searchParams = new URLSearchParams();

        // if we're fetching for Grafana managed rules, we should add a limit to the number of alert instances
        // we do this because the response is large otherwise and we don't show all of them in the UI anyway.
        if (limitAlerts) {
          searchParams.set('limit_alerts', String(limitAlerts));
        }

        if (identifier && (isPrometheusRuleIdentifier(identifier) || isCloudRuleIdentifier(identifier))) {
          searchParams.set('file', identifier.namespace);
          searchParams.set('rule_group', identifier.groupName);
        }

        const params = prepareRulesFilterQueryParams(searchParams, filter);

        return { url: PROM_RULES_URL, params: paramsWithMatcherAndState(params, state, matcher) };
      },
      transformResponse: (response: PromRulesResponse): RuleNamespace[] => {
        return groupRulesByFileName(response.data.groups, GRAFANA_RULES_SOURCE_NAME);
      },
    }),

    prometheusRuleNamespaces: build.query<
      RuleNamespace[],
      {
        ruleSourceName: string;
        namespace?: string;
        groupName?: string;
        ruleName?: string;
        dashboardUid?: string;
        panelId?: number;
      }
    >({
      query: ({ ruleSourceName, namespace, groupName, ruleName, dashboardUid, panelId }) => {
        const queryParams: Record<string, string | undefined> = {
          rule_group: groupName,
          rule_name: ruleName,
          dashboard_uid: dashboardUid, // Supported only by Grafana managed rules
          panel_id: panelId?.toString(), // Supported only by Grafana managed rules
        };

        if (namespace) {
          if (isGrafanaRulesSource(ruleSourceName)) {
            set(queryParams, 'folder_uid', namespace);
          } else {
            set(queryParams, 'file', namespace);
          }
        }

        return {
          url: `api/prometheus/${getDatasourceAPIUid(ruleSourceName)}/api/v1/rules`,
          params: queryParams,
        };
      },
      transformResponse: (response: PromRulesResponse, _, args): RuleNamespace[] => {
        return groupRulesByFileName(response.data.groups, args.ruleSourceName);
      },
      providesTags: ['CombinedAlertRule'],
    }),

    rulerRules: build.query<
      RulerRulesConfigDTO,
      { rulerConfig: RulerDataSourceConfig; filter?: FetchRulerRulesFilter }
    >({
      query: ({ rulerConfig, filter }) => {
        const { path, params } = rulerUrlBuilder(rulerConfig).rules(filter);
        return { url: path, params };
      },
      providesTags: ['CombinedAlertRule'],
    }),

    rulerNamespace: build.query<RulerRulesConfigDTO, { rulerConfig: RulerDataSourceConfig; namespace: string }>({
      query: ({ rulerConfig, namespace }) => {
        const { path, params } = rulerUrlBuilder(rulerConfig).namespace(namespace);
        return { url: path, params };
      },
    }),

    // TODO This should be probably a separate ruler API file
    getRuleGroupForNamespace: build.query<
      RulerRuleGroupDTO,
      { rulerConfig: RulerDataSourceConfig; namespace: string; group: string }
    >({
      query: ({ rulerConfig, namespace, group }) => {
        const { path, params } = rulerUrlBuilder(rulerConfig).namespaceGroup(namespace, group);
        return { url: path, params };
      },
      providesTags: ['CombinedAlertRule'],
    }),

    deleteRuleGroupFromNamespace: build.mutation<
      RulerRuleGroupDTO,
      { rulerConfig: RulerDataSourceConfig; namespace: string; group: string }
    >({
      query: ({ rulerConfig, namespace, group }) => {
        const { path, params } = rulerUrlBuilder(rulerConfig).namespaceGroup(namespace, group);
        return { url: path, params, method: 'DELETE' };
      },
      invalidatesTags: ['CombinedAlertRule'],
    }),

    getAlertRule: build.query<RulerGrafanaRuleDTO, { uid: string }>({
      // TODO: In future, if supported in other rulers, parametrize ruler source name
      // For now, to make the consumption of this hook clearer, only support Grafana ruler
      query: ({ uid }) => ({ url: `/api/ruler/${GRAFANA_RULES_SOURCE_NAME}/api/v1/rule/${uid}` }),
      providesTags: (_result, _error, { uid }) => [{ type: 'GrafanaRulerRule', id: uid }],
    }),

    exportRules: build.query<string, ExportRulesParams>({
      query: ({ format, folderUid, group, ruleUid }) => ({
        url: `/api/ruler/grafana/api/v1/export/rules`,
        params: { format: format, folderUid: folderUid, group: group, ruleUid: ruleUid },
        responseType: 'text',
      }),
      keepUnusedDataFor: 0,
    }),
    exportReceiver: build.query<string, { receiverName: string; decrypt: boolean; format: ExportFormats }>({
      query: ({ receiverName, decrypt, format }) => ({
        url: `/api/v1/provisioning/contact-points/export/`,
        params: { format: format, decrypt: decrypt, name: receiverName },
        responseType: 'text',
      }),
      keepUnusedDataFor: 0,
    }),
    exportReceivers: build.query<string, { decrypt: boolean; format: ExportFormats }>({
      query: ({ decrypt, format }) => ({
        url: `/api/v1/provisioning/contact-points/export/`,
        params: { format: format, decrypt: decrypt },
        responseType: 'text',
      }),
      keepUnusedDataFor: 0,
    }),
    exportPolicies: build.query<string, { format: ExportFormats }>({
      query: ({ format }) => ({
        url: `/api/v1/provisioning/policies/export/`,
        params: { format: format },
        responseType: 'text',
      }),
      keepUnusedDataFor: 0,
    }),
    exportModifiedRuleGroup: build.mutation<
      string,
      { payload: PostableRulerRuleGroupDTO; format: ExportFormats; nameSpaceUID: string }
    >({
      query: ({ payload, format, nameSpaceUID }) => ({
        url: `/api/ruler/grafana/api/v1/rules/${nameSpaceUID}/export/`,
        params: { format: format },
        responseType: 'text',
        data: payload,
        method: 'POST',
      }),
    }),
    exportMuteTimings: build.query<string, { format: ExportFormats }>({
      query: ({ format }) => ({
        url: `/api/v1/provisioning/mute-timings/export/`,
        params: { format: format },
        responseType: 'text',
      }),
      keepUnusedDataFor: 0,
    }),
    exportMuteTiming: build.query<string, { format: ExportFormats; muteTiming: string }>({
      query: ({ format, muteTiming }) => ({
        url: `/api/v1/provisioning/mute-timings/${muteTiming}/export/`,
        params: { format: format },
        responseType: 'text',
      }),
      keepUnusedDataFor: 0,
    }),
    updateRuleGroupForNamespace: build.mutation<
      AlertGroupUpdated,
      { rulerConfig: RulerDataSourceConfig; namespace: string; payload: PostableRulerRuleGroupDTO }
    >({
      query: ({ payload, namespace, rulerConfig }) => {
        const { path, params } = rulerUrlBuilder(rulerConfig).namespace(namespace);

        return {
          url: path,
          params,
          data: payload,
          method: 'POST',
        };
      },
      invalidatesTags: ['CombinedAlertRule'],
    }),
  }),
});
