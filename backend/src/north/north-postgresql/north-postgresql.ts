import fs from 'node:fs/promises';
import { Client, Pool, PoolClient } from 'pg';

import NorthConnector from '../north-connector';
import pino from 'pino';
import EncryptionService from '../../service/encryption.service';
import { NorthPostgreSQLSettings } from '../../../shared/model/north-settings.model';
import { CacheMetadata, OIBusTimeValue } from '../../../shared/model/engine.model';
import { OIBusError } from '../../model/engine.model';
import { NorthConnectorEntity } from '../../model/north-connector.model';
import NorthConnectorRepository from '../../repository/config/north-connector.repository';
import ScanModeRepository from '../../repository/config/scan-mode.repository';
import { BaseFolders } from '../../model/types';

/**
 * Class NorthPostgreSQL - sends time-series data to a PostgreSQL database
 */
export default class NorthPostgreSQL extends NorthConnector<NorthPostgreSQLSettings> {
  private pool: Pool | null = null;

  constructor(
    configuration: NorthConnectorEntity<NorthPostgreSQLSettings>,
    encryptionService: EncryptionService,
    northConnectorRepository: NorthConnectorRepository,
    scanModeRepository: ScanModeRepository,
    logger: pino.Logger,
    baseFolders: BaseFolders
  ) {
    super(configuration, encryptionService, northConnectorRepository, scanModeRepository, logger, baseFolders);
  }

  override async connect(): Promise<void> {
    try {
      const connectionConfig = {
        host: this.connector.settings.host,
        port: this.connector.settings.port,
        database: this.connector.settings.database,
        user: this.connector.settings.username,
        password: this.connector.settings.password ? await this.encryptionService.decryptText(this.connector.settings.password) : undefined,
        max: 10, // maximum number of clients in the pool
        idleTimeoutMillis: 30000, // how long a client is allowed to remain idle before being closed
        connectionTimeoutMillis: this.connector.settings.connectionTimeout * 1000
      };

      this.pool = new Pool(connectionConfig);

      // Test the connection
      const client = await this.pool.connect();

      if (this.connector.settings.createTableIfNotExists) {
        await this.createTableIfNotExists(client);
      }

      client.release();
      await super.connect();
    } catch (error) {
      throw new OIBusError(`Error connecting to PostgreSQL database: ${error}`, true);
    }
  }

  private async createTableIfNotExists(client: PoolClient): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${this.connector.settings.table} (
        id SERIAL PRIMARY KEY,
        point_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        data_value DOUBLE PRECISION,
        data_quality VARCHAR(50),
        digital_value VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Default index for common queries
    const createDefaultIndexQuery = `
      CREATE INDEX IF NOT EXISTS idx_${this.connector.settings.table}_point_timestamp 
      ON ${this.connector.settings.table} (point_id, timestamp)
    `;

    try {
      await client.query(createTableQuery);
      await client.query(createDefaultIndexQuery);

      // Create custom indexes if defined
      if (this.connector.settings.customIndexes && this.connector.settings.customIndexes.length > 0) {
        await this.createCustomIndexes(client);
      }

      this.logger.debug(`Table "${this.connector.settings.table}" and indexes created or already exist`);
    } catch (error) {
      this.logger.error(`Error creating table "${this.connector.settings.table}": ${error}`);
      throw error;
    }
  }

  private async createCustomIndexes(client: PoolClient): Promise<void> {
    for (const index of this.connector.settings.customIndexes!) {
      const uniqueKeyword = index.unique ? 'UNIQUE' : '';
      const indexName = `idx_${this.connector.settings.table}_${index.name}`;

      const createIndexQuery = `
        CREATE ${uniqueKeyword} INDEX IF NOT EXISTS ${indexName}
        ON ${this.connector.settings.table} (${index.column} ${index.order})
      `;

      try {
        await client.query(createIndexQuery);
        this.logger.debug(`Custom index "${indexName}" created on column "${index.column}"`);
      } catch (error) {
        this.logger.warn(`Failed to create custom index "${indexName}": ${error}`);
        // Don't throw here - continue with other indexes
      }
    }
  }

  async handleContent(cacheMetadata: CacheMetadata): Promise<void> {
    switch (cacheMetadata.contentType) {
      case 'time-values':
        return this.handleValues(JSON.parse(await fs.readFile(cacheMetadata.contentFile, { encoding: 'utf-8' })) as Array<OIBusTimeValue>);

      default:
        throw new OIBusError(`Content type "${cacheMetadata.contentType}" not supported by PostgreSQL North connector`, false);
    }
  }

  /**
   * Handle values by inserting them into PostgreSQL database.
   */
  async handleValues(values: Array<OIBusTimeValue>): Promise<void> {
    if (!this.pool) {
      throw new OIBusError('PostgreSQL pool not initialized', true);
    }

    if (values.length === 0) {
      this.logger.debug('No values to insert');
      return;
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Process values in batches
      for (let i = 0; i < values.length; i += this.connector.settings.batchSize) {
        const batch = values.slice(i, i + this.connector.settings.batchSize);
        await this.insertBatch(client, batch);
      }

      await client.query('COMMIT');
      this.logger.debug(`Successfully inserted ${values.length} values into PostgreSQL`);
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.error(`Error inserting values into PostgreSQL: ${error}`);
      throw new OIBusError(`Error inserting values into PostgreSQL: ${error}`, true);
    } finally {
      client.release();
    }
  }

  private async insertBatch(client: PoolClient, values: Array<OIBusTimeValue>): Promise<void> {
    const insertQuery = `
      INSERT INTO ${this.connector.settings.table} (point_id, timestamp, data_value, data_quality, digital_value)
      VALUES ($1, $2, $3, $4, $5)
    `;

    const insertPromises = values.map(async value => {
      const timestamp = new Date(value.timestamp);
      // Handle both string and number values, including digital values like "?28"
      let dataValue: number | null = null;
      let digitalValue: string | null = null;

      if (value.data.value !== null && value.data.value !== undefined) {
        if (typeof value.data.value === 'number') {
          dataValue = value.data.value;
        } else if (typeof value.data.value === 'string') {
          // Check if it's a digital value (starts with ?)
          if (value.data.value.startsWith('?')) {
            digitalValue = value.data.value;
            // Extract numeric part if possible
            const numericPart = value.data.value.substring(1);
            const parsed = parseFloat(numericPart);
            dataValue = isNaN(parsed) ? null : parsed;
          } else {
            // Regular numeric string
            const parsed = parseFloat(value.data.value);
            dataValue = isNaN(parsed) ? null : parsed;
          }
        }
      }
      const quality = value.data.quality || null;

      return client.query(insertQuery, [value.pointId, timestamp, dataValue, quality, digitalValue]);
    });

    await Promise.all(insertPromises);
  }

  override async testConnection(): Promise<void> {
    if (!this.connector.settings.host) {
      throw new OIBusError('Host is required', false);
    }

    if (!this.connector.settings.database) {
      throw new OIBusError('Database is required', false);
    }

    if (!this.connector.settings.username) {
      throw new OIBusError('Username is required', false);
    }

    const connectionConfig = {
      host: this.connector.settings.host,
      port: this.connector.settings.port,
      database: this.connector.settings.database,
      user: this.connector.settings.username,
      password: this.connector.settings.password ? await this.encryptionService.decryptText(this.connector.settings.password) : undefined,
      connectionTimeoutMillis: this.connector.settings.connectionTimeout * 1000,
    };

    const client = new Client(connectionConfig);

    try {
      await client.connect();
      await client.query('SELECT 1');
      this.logger.info('PostgreSQL connection test successful');
    } catch (error) {
      throw new OIBusError(`PostgreSQL connection test failed: ${error}`, false);
    } finally {
      await client.end();
    }
  }

  override async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.logger.info('Disconnected from PostgreSQL database');
    }
    await super.disconnect();
  }
}
