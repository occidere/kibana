/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom, { isBoom, Boom as BoomType } from '@hapi/boom';

import { SavedObjectsBulkUpdateResponse, SavedObjectsUpdateResponse } from 'kibana/server';
import { flattenCaseSavedObject } from '../../routes/api/utils';

import {
  ActionConnector,
  CaseResponseRt,
  CaseResponse,
  CaseStatuses,
  ExternalServiceResponse,
  ESCaseAttributes,
  CommentAttributes,
} from '../../../common/api';
import { buildCaseUserActionItem } from '../../services/user_actions/helpers';

import { CaseClientPush, CaseClientFactoryArguments } from '../types';
import { createIncident, getCommentContextFromAttributes, isCommentAlertType } from './utils';

const createError = (e: Error | BoomType, message: string): Error | BoomType => {
  if (isBoom(e)) {
    e.message = message;
    e.output.payload.message = message;
    return e;
  }

  return Error(message);
};

export const push = ({
  savedObjectsClient,
  caseService,
  caseConfigureService,
  userActionService,
  request,
  response,
}: CaseClientFactoryArguments) => async ({
  actionsClient,
  caseClient,
  caseId,
  connectorId,
}: CaseClientPush): Promise<CaseResponse> => {
  /* Start of push to external service */
  let theCase;
  let connector;
  let userActions;
  let alerts;
  let connectorMappings;
  let externalServiceIncident;

  try {
    [theCase, connector, userActions] = await Promise.all([
      caseClient.get({ id: caseId, includeComments: true }),
      actionsClient.get({ id: connectorId }),
      caseClient.getUserActions({ caseId }),
    ]);
  } catch (e) {
    const message = `Error getting case and/or connector and/or user actions: ${e.message}`;
    throw createError(e, message);
  }

  // We need to change the logic when we support subcases
  if (theCase?.status === CaseStatuses.closed) {
    throw Boom.conflict(
      `This case ${theCase.title} is closed. You can not pushed if the case is closed.`
    );
  }

  try {
    alerts = await caseClient.getAlerts({
      ids: theCase?.comments?.filter(isCommentAlertType).map((comment) => comment.alertId) ?? [],
    });
  } catch (e) {
    throw new Error(`Error getting alerts for case with id ${theCase.id}: ${e.message}`);
  }

  try {
    connectorMappings = await caseClient.getMappings({
      actionsClient,
      caseClient,
      connectorId: connector.id,
      connectorType: connector.actionTypeId,
    });
  } catch (e) {
    const message = `Error getting mapping for connector with id ${connector.id}: ${e.message}`;
    throw createError(e, message);
  }

  try {
    externalServiceIncident = await createIncident({
      actionsClient,
      theCase,
      userActions,
      connector: connector as ActionConnector,
      mappings: connectorMappings,
      alerts,
    });
  } catch (e) {
    const message = `Error creating incident for case with id ${theCase.id}: ${e.message}`;
    throw createError(e, message);
  }

  const pushRes = await actionsClient.execute({
    actionId: connector?.id ?? '',
    params: {
      subAction: 'pushToService',
      subActionParams: externalServiceIncident,
    },
  });

  if (pushRes.status === 'error') {
    throw Boom.failedDependency(
      pushRes.serviceMessage ?? pushRes.message ?? 'Error pushing to service'
    );
  }

  /* End of push to external service */

  /* Start of update case with push information */
  let user;
  let myCase;
  let myCaseConfigure;
  let comments;

  try {
    [user, myCase, myCaseConfigure, comments] = await Promise.all([
      caseService.getUser({ request, response }),
      caseService.getCase({
        client: savedObjectsClient,
        caseId,
      }),
      caseConfigureService.find({ client: savedObjectsClient }),
      caseService.getAllCaseComments({
        client: savedObjectsClient,
        caseId,
        options: {
          fields: [],
          page: 1,
          perPage: theCase?.totalComment ?? 0,
        },
      }),
    ]);
  } catch (e) {
    const message = `Error getting user and/or case and/or case configuration and/or case comments: ${e.message}`;
    throw createError(e, message);
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { username, full_name, email } = user;
  const pushedDate = new Date().toISOString();
  const externalServiceResponse = pushRes.data as ExternalServiceResponse;

  const externalService = {
    pushed_at: pushedDate,
    pushed_by: { username, full_name, email },
    connector_id: connector.id,
    connector_name: connector.name,
    external_id: externalServiceResponse.id,
    external_title: externalServiceResponse.title,
    external_url: externalServiceResponse.url,
  };

  let updatedCase: SavedObjectsUpdateResponse<ESCaseAttributes>;
  let updatedComments: SavedObjectsBulkUpdateResponse<CommentAttributes>;

  try {
    [updatedCase, updatedComments] = await Promise.all([
      caseService.patchCase({
        client: savedObjectsClient,
        caseId,
        updatedAttributes: {
          ...(myCaseConfigure.total > 0 &&
          myCaseConfigure.saved_objects[0].attributes.closure_type === 'close-by-pushing'
            ? {
                status: CaseStatuses.closed,
                closed_at: pushedDate,
                closed_by: { email, full_name, username },
              }
            : {}),
          external_service: externalService,
          updated_at: pushedDate,
          updated_by: { username, full_name, email },
        },
        version: myCase.version,
      }),

      caseService.patchComments({
        client: savedObjectsClient,
        comments: comments.saved_objects
          .filter((comment) => comment.attributes.pushed_at == null)
          .map((comment) => ({
            commentId: comment.id,
            updatedAttributes: {
              pushed_at: pushedDate,
              pushed_by: { username, full_name, email },
            },
            version: comment.version,
          })),
      }),

      userActionService.postUserActions({
        client: savedObjectsClient,
        actions: [
          ...(myCaseConfigure.total > 0 &&
          myCaseConfigure.saved_objects[0].attributes.closure_type === 'close-by-pushing'
            ? [
                buildCaseUserActionItem({
                  action: 'update',
                  actionAt: pushedDate,
                  actionBy: { username, full_name, email },
                  caseId,
                  fields: ['status'],
                  newValue: CaseStatuses.closed,
                  oldValue: myCase.attributes.status,
                }),
              ]
            : []),
          buildCaseUserActionItem({
            action: 'push-to-service',
            actionAt: pushedDate,
            actionBy: { username, full_name, email },
            caseId,
            fields: ['pushed'],
            newValue: JSON.stringify(externalService),
          }),
        ],
      }),
    ]);
  } catch (e) {
    const message = `Error updating case and/or comments and/or creating user action: ${e.message}`;
    throw createError(e, message);
  }
  /* End of update case with push information */

  return CaseResponseRt.encode(
    flattenCaseSavedObject({
      savedObject: {
        ...myCase,
        ...updatedCase,
        attributes: { ...myCase.attributes, ...updatedCase?.attributes },
        references: myCase.references,
      },
      comments: comments.saved_objects.map((origComment) => {
        const updatedComment = updatedComments.saved_objects.find((c) => c.id === origComment.id);
        return {
          ...origComment,
          ...updatedComment,
          attributes: {
            ...origComment.attributes,
            ...updatedComment?.attributes,
            ...getCommentContextFromAttributes(origComment.attributes),
          },
          version: updatedComment?.version ?? origComment.version,
          references: origComment?.references ?? [],
        };
      }),
    })
  );
};
