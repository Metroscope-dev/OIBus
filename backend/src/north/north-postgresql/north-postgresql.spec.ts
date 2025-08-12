import fs from 'node:fs/promises';
import { Client, Pool, PoolClient } from 'pg';

import NorthPostgreSQL from './north-postgresql';
import pino from 'pino';
import PinoLogger from '../../tests/__mocks__/service/logger/logger.mock';
import EncryptionService from '../../service/encryption.service';
import EncryptionServiceMock from '../../tests/__mocks__/service/encryption-service.mock';
import { NorthPostgreSQLSettings } from '../../../shared/model/north-settings.model';
import { OIBusTimeValue } from '../../../shared/model/engine.model';
import NorthConnectorRepository from '../../repository/config/north-connector.repository';
import NorthConnectorRepositoryMock from '../../tests/__mocks__/repository/config/north-connector-repository.mock';
import ScanModeRepository from '../../repository/config/scan-mode.repository';
import ScanModeRepositoryMock from '../../tests/__mocks__/repository/config/scan-mode-repository.mock';
import { NorthConnectorEntity } from '../../model/north-connector.model';
import testData from '../../tests/utils/test-data';
import { mockBaseFolders } from '../../tests/utils/test-utils';
import CacheService from '../../service/cache/cache.service';
import CacheServiceMock from '../../tests/__mocks__/service/cache/cache-service.mock';
import { OIBusError } from '../../model/engine.model';

jest.mock('node:fs/promises');
jest.mock('pg');

const logger: pino.Logger = new PinoLogger();
const encryptionService: EncryptionService = new EncryptionServiceMock('', '');
const northConnectorRepository: NorthConnectorRepository = new NorthConnectorRepositoryMock();
const scanModeRepository: ScanModeRepository = new ScanModeRepositoryMock();
const cacheService: CacheService = new CacheServiceMock();

jest.mock(
  '../../service/cache/cache.service',
  () =>
    function () {
      return cacheService;
    }
);

const settings: NorthPostgreSQLSettings = {
  host: 'localhost',
  port: 5432,
  database: 'test_db',
  username: 'test_user',
  password: 'encrypted_password',
  table: 'oibus_data',
  createTableIfNotExists: true,
  batchSize: 1000,
  connectionTimeout: 30,
  customIndexes: [
    {
      name: 'timestamp_desc',
      column: 'timestamp',
      unique: false,
      order: 'DESC'
    },
    {
      name: 'point_unique',
      column: 'point_id',
      unique: true,
      order: 'ASC'
    }
  ]
};

const timeValues: Array<OIBusTimeValue> = [
  {
    pointId: 'point1',
    timestamp: testData.constants.dates.FAKE_NOW,
    data: { value: 123.45, quality: 'good' }
  },
  {
    pointId: 'point2',
    timestamp: testData.constants.dates.FAKE_NOW,
    data: { value: 678.9, quality: 'good' }
  }
];

let configuration: NorthConnectorEntity<NorthPostgreSQLSettings>;
let north: NorthPostgreSQL;

describe('NorthPostgreSQL', () => {
  let mockPool: jest.Mocked<Pool>;
  let mockClient: jest.Mocked<PoolClient>;
  let mockTestClient: jest.Mocked<Client>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(testData.constants.dates.FAKE_NOW));

    configuration = JSON.parse(JSON.stringify(testData.north.list[0]));
    configuration.type = 'postgresql';
    configuration.settings = settings;

    (northConnectorRepository.findNorthById as jest.Mock).mockReturnValue(configuration);
    (scanModeRepository.findById as jest.Mock).mockImplementation(id => testData.scanMode.list.find(element => element.id === id));

    mockClient = {
      connect: jest.fn(),
      query: jest.fn(),
      release: jest.fn(),
      end: jest.fn()
    } as unknown as jest.Mocked<PoolClient>;

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      end: jest.fn(),
      query: jest.fn()
    } as unknown as jest.Mocked<Pool>;

    mockTestClient = {
      connect: jest.fn(),
      query: jest.fn(),
      end: jest.fn()
    } as unknown as jest.Mocked<Client>;

    (Pool as jest.MockedClass<typeof Pool>).mockImplementation(() => mockPool);
    (Client as jest.MockedClass<typeof Client>).mockImplementation(() => mockTestClient);

    north = new NorthPostgreSQL(
      configuration,
      encryptionService,
      northConnectorRepository,
      scanModeRepository,
      logger,
      mockBaseFolders(testData.north.list[0].id)
    );
  });

  afterEach(() => {
    cacheService.cacheSizeEventEmitter.removeAllListeners();
  });

  describe('connect', () => {
    beforeEach(() => {
      (encryptionService.decryptText as jest.Mock).mockImplementation((_text: string) => Promise.resolve('decrypted_password'));
    });

    it('should properly connect to PostgreSQL', async () => {
      await north.connect();

      expect(Pool).toHaveBeenCalledWith({
        host: 'localhost',
        port: 5432,
        database: 'test_db',
        user: 'test_user',
        password: 'decrypted_password',
        ssl: false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 30000
      });

      expect(mockPool.connect).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledTimes(4); // CREATE TABLE, CREATE DEFAULT INDEX, and 2 custom indexes
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should skip table creation when createTableIfNotExists is false', async () => {
      const skipTableSettings = { ...settings, createTableIfNotExists: false };
      const skipTableConfiguration = { ...configuration, settings: skipTableSettings };
      const skipTableNorth = new NorthPostgreSQL(
        skipTableConfiguration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await skipTableNorth.connect();

      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should throw error on connection failure', async () => {
      (mockPool.connect as jest.Mock).mockRejectedValue(new Error('Connection failed'));

      await expect(north.connect()).rejects.toThrow(OIBusError);
    });

    it('should create custom indexes when specified', async () => {
      await north.connect();

      // Verify custom indexes were created
      expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('CREATE  INDEX IF NOT EXISTS idx_oibus_data_timestamp_desc'));
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_oibus_data_point_unique')
      );
    });

    it('should handle custom index creation errors gracefully', async () => {
      // Mock one of the custom index queries to fail
      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({}) // CREATE DEFAULT INDEX
        .mockRejectedValueOnce(new Error('Index creation failed')) // First custom index fails
        .mockResolvedValueOnce({}); // Second custom index succeeds

      await north.connect();

      // Should not throw error even if custom index creation fails
      expect(mockClient.query).toHaveBeenCalledTimes(4);
    });

    it('should skip custom indexes when none are defined', async () => {
      const noIndexSettings = { ...settings, customIndexes: null };
      const noIndexConfiguration = { ...configuration, settings: noIndexSettings };
      const noIndexNorth = new NorthPostgreSQL(
        noIndexConfiguration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await noIndexNorth.connect();

      expect(mockClient.query).toHaveBeenCalledTimes(2); // Only CREATE TABLE and default index
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      (encryptionService.decryptText as jest.Mock).mockImplementation((_text: string) => Promise.resolve('decrypted_password'));
    });

    it('should test connection successfully', async () => {
      await north.testConnection();

      expect(mockTestClient.connect).toHaveBeenCalled();
      expect(mockTestClient.query).toHaveBeenCalledWith('SELECT 1');
      expect(mockTestClient.end).toHaveBeenCalled();
    });

    it('should throw error when host is missing', async () => {
      const invalidSettings = { ...settings, host: '' };
      const invalidConfiguration = { ...configuration, settings: invalidSettings };
      const invalidNorth = new NorthPostgreSQL(
        invalidConfiguration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await expect(invalidNorth.testConnection()).rejects.toThrow('Host is required');
    });

    it('should throw error when database is missing', async () => {
      const invalidSettings = { ...settings, database: '' };
      const invalidConfiguration = { ...configuration, settings: invalidSettings };
      const invalidNorth = new NorthPostgreSQL(
        invalidConfiguration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await expect(invalidNorth.testConnection()).rejects.toThrow('Database is required');
    });

    it('should throw error when username is missing', async () => {
      const invalidSettings = { ...settings, username: '' };
      const invalidConfiguration = { ...configuration, settings: invalidSettings };
      const invalidNorth = new NorthPostgreSQL(
        invalidConfiguration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await expect(invalidNorth.testConnection()).rejects.toThrow('Username is required');
    });

    it('should throw error when connection test fails', async () => {
      (mockTestClient.connect as jest.Mock).mockRejectedValue(new Error('Connection test failed'));

      await expect(north.testConnection()).rejects.toThrow(OIBusError);
    });
  });

  describe('handleContent', () => {
    beforeEach(async () => {
      (encryptionService.decryptText as jest.Mock).mockImplementation((_text: string) => Promise.resolve('decrypted_password'));
      await north.connect();
    });

    it('should handle time-values content', async () => {
      (fs.readFile as jest.Mock).mockReturnValue(JSON.stringify(timeValues));

      await north.handleContent({
        contentFile: '/path/to/file/example-123.json',
        contentSize: 1234,
        numberOfElement: 2,
        createdAt: '2020-02-02T02:02:02.222Z',
        contentType: 'time-values',
        source: 'south',
        options: {}
      });

      expect(fs.readFile).toHaveBeenCalledWith('/path/to/file/example-123.json', { encoding: 'utf-8' });
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should throw error for unsupported content type', async () => {
      await expect(
        north.handleContent({
          contentFile: '/path/to/file/example.txt',
          contentSize: 1234,
          numberOfElement: 1,
          createdAt: '2020-02-02T02:02:02.222Z',
          contentType: 'raw',
          source: 'south',
          options: {}
        })
      ).rejects.toThrow('Content type "raw" not supported by PostgreSQL North connector');
    });
  });

  describe('handleValues', () => {
    beforeEach(async () => {
      (encryptionService.decryptText as jest.Mock).mockImplementation((_text: string) => Promise.resolve('decrypted_password'));
      await north.connect();
    });

    it('should handle values successfully', async () => {
      await north.handleValues(timeValues);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point1', new Date(testData.constants.dates.FAKE_NOW), 123.45, 'good', null]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point2', new Date(testData.constants.dates.FAKE_NOW), 678.9, 'good', null]
      );
    });

    it('should handle empty values array', async () => {
      await north.handleValues([]);

      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should handle string values correctly', async () => {
      const stringValues: Array<OIBusTimeValue> = [
        {
          pointId: 'point3',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: '456.78', quality: 'good' }
        },
        {
          pointId: 'point4',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: 'invalid', quality: 'bad' }
        },
        {
          pointId: 'point5',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: '0', quality: 'good' }
        }
      ];

      await north.handleValues(stringValues);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      // String "456.78" should be parsed to number 456.78
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point3', new Date(testData.constants.dates.FAKE_NOW), 456.78, 'good', null]
      );
      // String "invalid" should be converted to null
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point4', new Date(testData.constants.dates.FAKE_NOW), null, 'bad', null]
      );
      // String "0" should be parsed to number 0
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point5', new Date(testData.constants.dates.FAKE_NOW), 0, 'good', null]
      );
    });

    it('should handle null and undefined values correctly', async () => {
      const nullValues: Array<OIBusTimeValue> = [
        {
          pointId: 'point6',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: null as unknown as string, quality: 'bad' }
        },
        {
          pointId: 'point7',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: undefined as unknown as string, quality: 'bad' }
        }
      ];

      await north.handleValues(nullValues);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      // Both null and undefined should result in null in database
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point6', new Date(testData.constants.dates.FAKE_NOW), null, 'bad', null]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['point7', new Date(testData.constants.dates.FAKE_NOW), null, 'bad', null]
      );
    });

    it('should handle digital values correctly', async () => {
      const digitalValues: Array<OIBusTimeValue> = [
        {
          pointId: 'digital1',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: '?28', quality: 'good' }
        },
        {
          pointId: 'digital2',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: '?0', quality: 'good' }
        },
        {
          pointId: 'digital3',
          timestamp: testData.constants.dates.FAKE_NOW,
          data: { value: '?invalid', quality: 'bad' }
        }
      ];

      await north.handleValues(digitalValues);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      // Digital value "?28" should store both the numeric value and the original digital value
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['digital1', new Date(testData.constants.dates.FAKE_NOW), 28, 'good', '?28']
      );
      // Digital value "?0" should store 0 as numeric and "?0" as digital
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['digital2', new Date(testData.constants.dates.FAKE_NOW), 0, 'good', '?0']
      );
      // Digital value "?invalid" should store null as numeric but keep the original digital value
      expect(mockClient.query).toHaveBeenCalledWith(
        `INSERT INTO ${settings.table} (point_id, timestamp, data_value, data_quality, digital_value) VALUES ($1, $2, $3, $4, $5)`,
        ['digital3', new Date(testData.constants.dates.FAKE_NOW), null, 'bad', '?invalid']
      );
    });

    it('should rollback on error', async () => {
      (mockClient.query as jest.Mock).mockRejectedValueOnce(new Error('Database error'));

      await expect(north.handleValues(timeValues)).rejects.toThrow('Error inserting values into PostgreSQL: Error: Database error');

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should throw error when pool is not initialized', async () => {
      const uninitializedNorth = new NorthPostgreSQL(
        configuration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await expect(uninitializedNorth.handleValues(timeValues)).rejects.toThrow('PostgreSQL pool not initialized');
    });
  });

  describe('disconnect', () => {
    beforeEach(async () => {
      (encryptionService.decryptText as jest.Mock).mockImplementation((_text: string) => Promise.resolve('decrypted_password'));
      await north.connect();
    });

    it('should disconnect properly', async () => {
      await north.disconnect();

      expect(mockPool.end).toHaveBeenCalled();
    });

    it('should handle disconnect when pool is not initialized', async () => {
      const uninitializedNorth = new NorthPostgreSQL(
        configuration,
        encryptionService,
        northConnectorRepository,
        scanModeRepository,
        logger,
        mockBaseFolders(testData.north.list[0].id)
      );

      await expect(uninitializedNorth.disconnect()).resolves.not.toThrow();
    });
  });
});
