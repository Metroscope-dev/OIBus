import { SouthConnectorManifest } from '../../../shared/model/south-connector.model';

const manifest: SouthConnectorManifest = {
  id: 'osisoft-pi-webapi',
  category: 'api',
  modes: {
    subscription: false,
    lastPoint: false,
    lastFile: false,
    history: true
  },
  settings: [
    {
      key: 'throttling',
      type: 'OibFormGroup',
      translationKey: 'south.osisoft-pi-webapi.throttling.title',
      class: 'col',
      newRow: true,
      displayInViewMode: false,
      validators: [{ key: 'required' }],
      content: [
        {
          key: 'maxReadInterval',
          type: 'OibNumber',
          translationKey: 'south.osisoft-pi-webapi.throttling.max-read-interval',
          validators: [{ key: 'required' }, { key: 'min', params: { min: 0 } }],
          defaultValue: 3600,
          unitLabel: 's',
          displayInViewMode: true
        },
        {
          key: 'readDelay',
          type: 'OibNumber',
          translationKey: 'south.osisoft-pi-webapi.throttling.read-delay',
          validators: [{ key: 'required' }, { key: 'min', params: { min: 0 } }],
          defaultValue: 200,
          unitLabel: 'ms',
          displayInViewMode: true
        },
        {
          key: 'overlap',
          type: 'OibNumber',
          translationKey: 'south.osisoft-pi-webapi.throttling.overlap',
          validators: [{ key: 'required' }, { key: 'min', params: { min: 0 } }],
          defaultValue: 0,
          unitLabel: 'ms',
          displayInViewMode: true
        },
        {
          key: 'maxInstantPerItem',
          type: 'OibCheckbox',
          translationKey: 'south.osisoft-pi-webapi.throttling.max-instant-per-item',
          defaultValue: false,
          validators: [{ key: 'required' }],
          displayInViewMode: true
        }
      ]
    },
    {
      key: 'url',
      type: 'OibText',
      translationKey: 'south.osisoft-pi-webapi.url',
      defaultValue: 'https://pi.dev.metroscope.io/piwebapi/',
      validators: [{ key: 'required' }],
      newRow: true,
      displayInViewMode: true
    },
    {
      key: 'dataServerWebId',
      type: 'OibText',
      translationKey: 'south.osisoft-pi-webapi.data-server-web-id',
      defaultValue: 'F1DSC4n4q_2uRUWxuLuRsKCl8QVk0tUEktU0VSVkVSLVRF',
      validators: [{ key: 'required' }],
      newRow: true,
      displayInViewMode: true
    },
    {
      key: 'username',
      type: 'OibText',
      translationKey: 'south.osisoft-pi-webapi.username',
      validators: [{ key: 'required' }],
      newRow: true,
      displayInViewMode: true
    },
    {
      key: 'password',
      type: 'OibSecret',
      translationKey: 'south.osisoft-pi-webapi.password',
      class: 'col-4',
      displayInViewMode: false
    },
    {
      key: 'acceptUnauthorized',
      type: 'OibCheckbox',
      translationKey: 'south.osisoft-pi-webapi.accept-unauthorized',
      defaultValue: false,
      validators: [{ key: 'required' }],
      class: 'col-4',
      displayInViewMode: true
    },
    {
      key: 'timeout',
      type: 'OibNumber',
      translationKey: 'south.osisoft-pi-webapi.timeout',
      defaultValue: 30,
      unitLabel: 's',
      class: 'col-3',
      validators: [{ key: 'required' }, { key: 'min', params: { min: 1 } }, { key: 'max', params: { max: 300 } }],
      displayInViewMode: true
    },
    {
      key: 'retryInterval',
      type: 'OibNumber',
      translationKey: 'south.osisoft-pi-webapi.retry-interval',
      defaultValue: 10000,
      unitLabel: 'ms',
      class: 'col-3',
      validators: [{ key: 'required' }, { key: 'min', params: { min: 100 } }, { key: 'max', params: { max: 30000 } }],
      displayInViewMode: true
    }
  ],
  items: {
    scanMode: 'POLL',
    settings: [
      {
        key: 'pointWebId',
        type: 'OibText',
        translationKey: 'south.osisoft-pi-webapi.point-web-id',
        validators: [{ key: 'required' }],
        displayInViewMode: false,
        class: 'col-12 d-none' // Hidden field - set programmatically
      }
    ]
  }
};
export default manifest;
