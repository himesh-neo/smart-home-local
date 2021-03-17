/**
 * Copyright 2019, Google LLC
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *   http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/// <reference types="@google/local-home-sdk" />

import {ControlKind} from '../common/discovery';
import {IColorAbsolute, ICustomData, IDiscoveryData} from './types';
import {decrypt, encrypt} from './crypto';

import {DOMParser} from 'xmldom';
import cbor from 'cbor';

/* tslint:disable:no-var-requires */
// TODO(proppy): add typings
require('array.prototype.flatmap/auto');
const opcStream = require('opc');
/* tslint:enable:no-var-requires */

function makeSendCommand(protocol: ControlKind, data: string, path?: string) {
  switch (protocol) {
    case ControlKind.HTTP:
      return makeHttpPost(data, path);
    default:
      throw Error(`Unsupported protocol for send: ${protocol}`);
  }
}

function makeReceiveCommand(protocol: ControlKind, path?: string) {
  switch (protocol) {
    case ControlKind.TCP:
      return makeTcpRead();
    case ControlKind.HTTP:
      return makeHttpGet(path);
    default:
      throw Error(`Unsupported protocol for receive: ${protocol}`);
  }
}

function makeUdpSend(buf: Buffer) {
  const command = new smarthome.DataFlow.UdpRequestData();
  command.data = buf.toString('hex');
  return command;
}

function makeTcpWrite(buf: Buffer) {
  const command = new smarthome.DataFlow.TcpRequestData();
  command.operation = smarthome.Constants.TcpOperation.WRITE;
  command.data = buf.toString('hex');
  return command;
}

function makeTcpRead() {
  const command = new smarthome.DataFlow.TcpRequestData();
  command.operation = smarthome.Constants.TcpOperation.READ;
  command.bytesToRead = 1024;
  return command;
}

function makeHttpGet(path?: string) {
  const command = new smarthome.DataFlow.HttpRequestData();
  command.method = smarthome.Constants.HttpOperation.GET;
  if (path !== undefined) {
    command.path = path;
  }
  return command;
}

function makeHttpPost(data: string, path?: string) {
  const command = new smarthome.DataFlow.HttpRequestData();
  command.method = smarthome.Constants.HttpOperation.POST;
  command.data = encrypt(data, 'cipher-secret');
  console.log('encrypted -', command.data);
  let decypted = decrypt(command.data, 'cipher-secret');
  console.log('decrypted -', decypted);
  let decryptedHack = decrypt(command.data, 'hello world');
  console.log('decrypted with invalid key -', decryptedHack);
  command.dataType = 'application/octet-stream';
  if (path !== undefined) {
    command.path = path;
  }
  return command;
}

// HomeApp implements IDENTIFY and EXECUTE handler for smarthome local device
// execution.
export class HomeApp {
  constructor(private readonly app: smarthome.App) {
    this.app = app;
  }

  // identifyHandlers decode UDP scan data and structured device information.
  public identifyHandler = async(
      identifyRequest: smarthome.IntentFlow.IdentifyRequest):
      Promise<smarthome.IntentFlow.IdentifyResponse> => {
        console.log(
            `IDENTIFY request ${JSON.stringify(identifyRequest, null, 2)}`);
        // TODO(proppy): handle multiple inputs.
        const device = identifyRequest.inputs[0].payload.device;
        const discoveryData: IDiscoveryData =
            await this.getDiscoveryData(device, identifyRequest.requestId);
        console.log(`discoveryData: ${JSON.stringify(discoveryData, null, 2)}`);

        const identifyResponse: smarthome.IntentFlow.IdentifyResponse = {
          requestId: identifyRequest.requestId,
          intent: smarthome.Intents.IDENTIFY,
          payload: {
            device: {
              deviceInfo: {
                manufacturer: 'fakecandy corp',
                model: discoveryData.model,
                hwVersion: discoveryData.hw_rev || '',
                swVersion: discoveryData.fw_rev || '',
              },
              ...((discoveryData.channels.length > 1) ?
                      {id: discoveryData.id, isProxy: true, isLocalOnly: true} :
                      {
                        id: discoveryData.id || 'deviceId',
                        verificationId: discoveryData.id,
                      }),
            },
          },
        };
        console.log(
            `IDENTIFY response ${JSON.stringify(identifyResponse, null, 2)}`);
        return identifyResponse;
      }

  public reachableDevicesHandler = async(
      reachableDevicesRequest: smarthome.IntentFlow.ReachableDevicesRequest):
      Promise<smarthome.IntentFlow.ReachableDevicesResponse> => {
        console.log(`REACHABLE_DEVICES request ${
            JSON.stringify(reachableDevicesRequest, null, 2)}`);

        const proxyDeviceId =
            reachableDevicesRequest.inputs[0].payload.device.id;
        const devices = reachableDevicesRequest.devices.flatMap((d) => {
          const customData = d.customData as ICustomData;
          if (customData.proxy === proxyDeviceId) {
            return [{verificationId: `${proxyDeviceId}-${customData.channel}`}];
          }
          return [];
        });
        const reachableDevicesResponse = {
          intent: smarthome.Intents.REACHABLE_DEVICES,
          requestId: reachableDevicesRequest.requestId,
          payload: {
            devices,
          },
        };
        console.log(`REACHABLE_DEVICES response ${
            JSON.stringify(reachableDevicesResponse, null, 2)}`);
        return reachableDevicesResponse;
      }

  // executeHandler send openpixelcontrol messages corresponding to light device
  // commands.
  public executeHandler = async(
      executeRequest: smarthome.IntentFlow.ExecuteRequest):
      Promise<smarthome.IntentFlow.ExecuteResponse> => {
        console.log(
            `EXECUTE request: ${JSON.stringify(executeRequest, null, 2)}`);
        // TODO(proppy): handle multiple inputs/commands.
        const command = executeRequest.inputs[0].payload.commands[0];
        // TODO(proppy): handle multiple executions.
        const execution = command.execution[0];
        const params: Object = execution.params as Object;

        const executeResponse =
            new smarthome.Execute.Response.Builder().setRequestId(
                executeRequest.requestId);
        // Handle light device commands for all devices.
        await Promise.all(command.devices.map(async (device) => {
          const customData = device.customData as ICustomData;
          // Create OPC set-pixel 8-bit message from ColorAbsolute command
          let data: string = 'Hello from local'
          const deviceCommand =
              makeSendCommand(customData.control_protocol, data);
          deviceCommand.requestId = executeRequest.requestId;
          deviceCommand.deviceId = device.id;
          deviceCommand.port = customData.port;

          console.log(
              `${customData.control_protocol} RequestData: `, deviceCommand);
          try {
            const result =
                await this.app.getDeviceManager().send(deviceCommand);
            console.log(result);
            const state = {
              ...params,
              online: true,
            };
            executeResponse.setSuccessState(result.deviceId, state);
          } catch (e) {
            executeResponse.setErrorState(device.id, e.errorCode);
          }
        }));
        console.log(
            `EXECUTE response: ${JSON.stringify(executeResponse, null, 2)}`);
        // Return execution response to smarthome infrastructure.
        return executeResponse.build();
      }

  private getDiscoveryData = async(
    device: smarthome.IntentFlow.LocalIdentifiedDevice,
    requestId: string,    
  ): Promise<IDiscoveryData> => {
    if (device.mdnsScanData !== undefined) { // mDNS discovery
      const scanData = device.mdnsScanData as smarthome.IntentFlow.MdnsScanData;
      return {
        id: scanData.txt.id,
        model: scanData.txt.model,
        hw_rev: scanData.txt.hw_rev,
        fw_rev: scanData.txt.fw_rev,
        channels: scanData.txt.channels
          .split(',')
          .map((channel) => parseInt(channel, 10)),
      };

    } 
    throw Error(
        `Missing or incorrect scan data for intent requestId ${requestId}`);
  }
}
