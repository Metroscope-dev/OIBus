import { NorthConnectorManifest } from '../../../shared/model/north-connector.model';

const manifest: NorthConnectorManifest = {
  id: 'postgresql',
  category: 'api',
  modes: {
    files: false,
    points: true
  },
  settings: [
    {
      key: 'host',
      type: 'OibText',
      translationKey: 'north.postgresql.host',
      newRow: true,
      defaultValue: 'localhost',
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      class: 'col-6'
    },
    {
      key: 'port',
      type: 'OibNumber',
      translationKey: 'north.postgresql.port',
      defaultValue: 5432,
      validators: [{ key: 'required' }, { key: 'min', params: { min: 1 } }, { key: 'max', params: { max: 65535 } }],
      displayInViewMode: true,
      class: 'col-3'
    },
    {
      key: 'database',
      type: 'OibText',
      translationKey: 'north.postgresql.database',
      newRow: true,
      defaultValue: '',
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      class: 'col-6'
    },
    {
      key: 'username',
      type: 'OibText',
      translationKey: 'north.postgresql.username',
      defaultValue: '',
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      class: 'col-3'
    },
    {
      key: 'password',
      type: 'OibSecret',
      translationKey: 'north.postgresql.password',
      defaultValue: '',
      class: 'col-3'
    },
    {
      key: 'table',
      type: 'OibText',
      translationKey: 'north.postgresql.table',
      newRow: true,
      defaultValue: 'oibus_data',
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      class: 'col-6'
    },
    {
      key: 'createTableIfNotExists',
      type: 'OibCheckbox',
      translationKey: 'north.postgresql.create-table-if-not-exists',
      defaultValue: true,
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      class: 'col-3'
    },
    {
      key: 'batchSize',
      type: 'OibNumber',
      translationKey: 'north.postgresql.batch-size',
      defaultValue: 1000,
      validators: [{ key: 'required' }, { key: 'min', params: { min: 1 } }, { key: 'max', params: { max: 10000 } }],
      displayInViewMode: true,
      class: 'col-3'
    },
    {
      key: 'connectionTimeout',
      type: 'OibNumber',
      translationKey: 'north.postgresql.connection-timeout',
      newRow: true,
      defaultValue: 30,
      unitLabel: 's',
      validators: [{ key: 'required' }, { key: 'min', params: { min: 1 } }],
      displayInViewMode: true,
      class: 'col-3'
    },
    {
      key: 'useSSL',
      type: 'OibCheckbox',
      translationKey: 'north.postgresql.use-ssl',
      defaultValue: false,
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      class: 'col-3'
    },
    {
      key: 'rejectUnauthorized',
      type: 'OibCheckbox',
      translationKey: 'north.postgresql.reject-unauthorized',
      defaultValue: true,
      displayInViewMode: true,
      validators: [{ key: 'required' }],
      conditionalDisplay: { field: 'useSSL', values: [true] },
      class: 'col-3'
    },
    {
      key: 'customIndexes',
      type: 'OibArray',
      translationKey: 'north.postgresql.custom-indexes.custom-index',
      content: [
        {
          key: 'name',
          translationKey: 'north.postgresql.custom-indexes.name',
          type: 'OibText',
          defaultValue: '',
          validators: [{ key: 'required' }],
          displayInViewMode: true,
          class: 'col-4'
        },
        {
          key: 'column',
          translationKey: 'north.postgresql.custom-indexes.column',
          type: 'OibSelect',
          defaultValue: 'timestamp',
          validators: [{ key: 'required' }],
          displayInViewMode: true,
          options: ['timestamp', 'point_id', 'data_value', 'data_quality', 'digital_value', 'created_at'],
          class: 'col-4'
        },
        {
          key: 'unique',
          translationKey: 'north.postgresql.custom-indexes.unique',
          type: 'OibCheckbox',
          defaultValue: false,
          displayInViewMode: true,
          validators: [{ key: 'required' }],
          class: 'col-2'
        },
        {
          key: 'order',
          translationKey: 'north.postgresql.custom-indexes.order',
          type: 'OibSelect',
          defaultValue: 'ASC',
          validators: [{ key: 'required' }],
          displayInViewMode: true,
          options: ['ASC', 'DESC'],
          class: 'col-2'
        }
      ],
      class: 'col',
      newRow: true,
      displayInViewMode: false
    }
  ]
};

export default manifest;
