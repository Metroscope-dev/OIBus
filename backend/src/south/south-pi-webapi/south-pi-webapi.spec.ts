import SouthPIWebAPI from './south-pi-webapi';
import { SouthPIWebAPISettings, SouthPIWebAPIItemSettings } from '../../../shared/model/south-settings.model';
import { SouthConnectorEntity } from '../../model/south-connector.model';
import EncryptionService from '../../service/encryption.service';
import EncryptionServiceMock from '../../tests/__mocks__/service/encryption-service.mock';
import SouthConnectorRepository from '../../repository/config/south-connector.repository';
import SouthCacheRepository from '../../repository/cache/south-cache.repository';
import ScanModeRepository from '../../repository/config/scan-mode.repository';
import pino from 'pino';

// Mock implementations for testing
const mockEncryptionService: EncryptionService = new EncryptionServiceMock('', '');
const mockSouthConnectorRepository = {} as SouthConnectorRepository;
const mockSouthCacheRepository = {} as SouthCacheRepository;
const mockScanModeRepository = {} as ScanModeRepository;
const mockLogger = pino();
const mockBaseFolders = {
  cache: '/tmp/cache',
  archive: '/tmp/archive',
  error: '/tmp/error'
};

const mockSettings: SouthPIWebAPISettings = {
  throttling: {
    maxReadInterval: 3600,
    readDelay: 200,
    overlap: 0,
    maxInstantPerItem: false
  },
  url: 'https://pi.dev.metroscope.io/piwebapi/',
  dataServerWebId: 'F1DSC4n4q_2uRUWxuLuRsKCl8QVk0tUEktU0VSVkVSLVRF',
  username: 'testuser',
  password: 'testpass',
  acceptUnauthorized: false,
  timeout: 30,
  retryInterval: 10000
};

const mockItemSettings: SouthPIWebAPIItemSettings = {
  pointWebId: 'F1DPC4n4q_2uRUWxuLuRsKCl8QBAAAAAVk0tUEktU0VSVkVSLVRFXENISUxMRVJfT05fQ0hJTExFUl8xMDE'
};

const mockConnector: SouthConnectorEntity<SouthPIWebAPISettings, SouthPIWebAPIItemSettings> = {
  id: 'test-pi-webapi',
  name: 'Test PI Web API',
  type: 'osisoft-pi-webapi',
  description: 'Test PI Web API connector',
  enabled: true,
  settings: mockSettings,
  items: [
    {
      id: 'item1',
      name: 'chiller_on_chiller_101',
      enabled: true,
      settings: mockItemSettings,
      scanModeId: 'scanMode1'
    }
  ]
};

describe('SouthPIWebAPI', () => {
  let connector: SouthPIWebAPI;

  beforeEach(() => {
    connector = new SouthPIWebAPI(
      mockConnector,
      jest.fn(),
      mockEncryptionService,
      mockSouthConnectorRepository,
      mockSouthCacheRepository,
      mockScanModeRepository,
      mockLogger,
      mockBaseFolders
    );
  });

  it('should create an instance', () => {
    expect(connector).toBeDefined();
    expect(connector).toBeInstanceOf(SouthPIWebAPI);
  });

  it('should have correct throttling settings', () => {
    const throttling = connector.getThrottlingSettings(mockSettings);
    expect(throttling.maxReadInterval).toBe(3600);
    expect(throttling.readDelay).toBe(200);
  });

  it('should handle max instant per item setting', () => {
    expect(connector.getMaxInstantPerItem(mockSettings)).toBe(false);
  });

  it('should handle overlap setting', () => {
    expect(connector.getOverlap(mockSettings)).toBe(0);
  });

  it('should ensure URL ends with slash', () => {
    const result = connector.ensureUrlEndsWithSlash('https://example.com');
    expect(result).toBe('https://example.com/');

    const resultWithSlash = connector.ensureUrlEndsWithSlash('https://example.com/');
    expect(resultWithSlash).toBe('https://example.com/');
  });
});
