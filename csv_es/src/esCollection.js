const logger = require('./esLogger.js');

const csv = require('fast-csv');
const elasticsearch = require('elasticsearch');
const fs = require('fs');
const path = require('path');
const shell = require('shelljs');
const tmp = require('tmp');
const _ = require('lodash');

function ESCollectionException(message) {
	this.message = message;
	this.name = "ESCollectionException";
}

function doCSVKeysMatch(csvFilePathA, csvFilePathB, delim = ",") {
	const proms = [];
	proms.push(readFirstLine(csvFilePathA));
	proms.push(readFirstLine(csvFilePathB));
	const all = Promise.all(proms);
	return all.then((res) => {
		const keysA = res[0].split(delim);
		const keysB = res[1].split(delim);
		return _.difference(keysA, keysB).length === 0 && _.difference(keysB, keysA).length === 0;
	}, (err) => {
		throw err;
	});
}

function logShellOutput(op) {
	if (op.code === 0) {
		logger.info(op.stdout);
	} else {
		logger.error(op.sterr);
	}
}

function readFirstLine (path) {
	return new Promise(function (resolve, reject) {
		const rs = fs.createReadStream(path, {encoding: 'utf8'});
		let acc = '';
		let pos = 0;
		let index;
		rs
			.on('data', function (chunk) {
				index = chunk.indexOf('\n');
				acc += chunk;
				index !== -1 ? rs.close() : pos += chunk.length;
			})
			.on('close', function () {
				resolve(acc.slice(0, pos + index));
			})
			.on('error', function (err) {
				reject(err);
			})
	});
}

module.exports = class ESCollection {
	constructor(esHost) {
		this._didInit = false;
		this._esHost = esHost;
		this._client = new elasticsearch.Client({
			host: this._esHost
		});
	}

	/**
	 * Check whether or not the collection metadata exists
	 * @private
	 * @return {Promise} Resolved when the elasticsearch request completes
	 */
	_collectionMetadataExists() {
		return new Promise((resolve, reject) => {
			this._client.exists({
				index: 'collection',
				type: 'meta',
				id: 1
			}, (error, exists) => {
				if (error) reject(error);
				resolve(exists);
			});
		});
	}

	/**
	 * Creates a meta type for the collection index, if necessary
	 * @private
	 * @return {Promise} Resolved when the elasticsearch request completes
	 */
	_createCollectionMetadata() {
		return new Promise((resolve, reject) => {
			this._client.create({
				index: 'collection',
				type: 'meta',
				id: 1,
				body: {
					hasImportedCSV: false,
					lastCSVImportTimestamp: 0
				}
			}, (error, response) => {
				if (error) reject(error);
				resolve(error);
			});
		});
	}

	/**
	 * Create a new object document, for the given dictionary of CSV data
	 * @private
	 * @param {object} data - key-value pairs to add for the given object
	 * @return {Promise} Resolved when the elasticsearch request completes
	 */
	_createDocumentWithData(data) {
		let dataCopy = Object.assign({}, data);
		dataCopy.id = parseInt(dataCopy.id);
		dataCopy = _.mapValues(dataCopy, (v, k) => {
			if (v === "") return null;
			return v;
		});
		return new Promise((resolve, reject) => {
			this._client.create({
				index: 'collection',
				type: 'object',
				id: dataCopy.id,
				body: dataCopy
			}, (error, response) => {
				if (error) reject(error);
				resolve(response);
			});
		});
	}

	_deleteDocumentWithId(docId) {
		return new Promise((resolve, reject) => {
			this._client.delete({
				index: 'collection',
				type: 'object',
				id: docId
			}, function(error, response) {
				if (error) reject(error);
				resolve(response);
			});
		});
	}

	_diffCSV(old_csv_path, new_csv_path) {
		const pyDiff = path.resolve(__dirname, "../../py_csv_diff/py_csv_diff.py");
		const resolvedOldPath = path.relative(".", old_csv_path);
		const resolvedNewPath = path.relative(".", new_csv_path);
		const tmpDir = tmp.dirSync();
		const outputJsonFile = path.join(tmpDir.name, "diff.json");
		logger.info(`Running CSV diff python script on ${old_csv_path} ${new_csv_path}`);
		logShellOutput(shell.exec("source activate tmsdiff"));
		logShellOutput(shell.exec(`python ${pyDiff} ${resolvedOldPath} ${resolvedNewPath} ${outputJsonFile}`));
		logShellOutput(shell.exec("source deactivate"));
		return JSON.parse(fs.readFileSync(outputJsonFile));
	}

	_getLastCSVName() {
		return new Promise((resolve, reject) => {
			this._client.get({
				index: 'collection',
				type: 'meta',
				id: 1
			}, function(error, response) {
				if (error) reject(error);
				if (response._source.hasImportedCSV === false) resolve(null);
				resolve("csv_" + response._source.lastCSVImportTimestamp);
			});
		});
	}

	/**
	 * Synchronize the elasticsearch index withe given CSV file
	 * @param {string} Path to the CSV file with which to synchronize
	 */
	_syncESWithCSV(csvFilePath) {
		csv
			.fromPath(csvFilePath, { headers: true })
			.on('data', (data) => {
				this._createDocumentWithData(data, this._client);
			})
			.on('end', () => {
				this._updateMetaForCSVFile(csvFilePath).then(() => {
					console.log('Finished export');
				});
			});
	}

	_updateDocumentWithData(docId, data) {
		return new Promise((resolve, reject) => {
			this._client.update({
				index: 'collection',
				type: 'object',
				id: docId,
				body: {
					doc: data
				}
			}, function(error, response) {
				if (error) reject(error);
				resolve(response);
			});
		});
	}

	_updateESWithCSV(csvFilePath) {
		const csvDir = path.resolve(path.dirname(csvFilePath), "..");
		const tmpDir = tmp.dirSync();
		const outputJsonFile = path.join(tmpDir.name, "diff.json");
		return this._getLastCSVName().then((oldCsvName) => {
			logger.info(`Previously imported csv ${oldCsvName}`);
			const oldCsvPath = path.join(csvDir, oldCsvName, "objects.csv");
			const res = this._diffCSV(oldCsvPath, csvFilePath);
			return this._updateESWithDiffJSON(res);
		}).then(() => {
			logger.info(`Finished import, updating index metadata`);
			return this._updateMetaForCSVFile(csvFilePath);
		});
	}

	_updateESWithDiffJSON(diffJson) {
		const todos = [];
		logger.info(
			`Updating to new CSV. 
			${diffJson.added.length} new documents, 
			${diffJson.changed.length} changed documents, 
			${diffJson.removed.length} removed documents.`
		);
		_.forEach(diffJson.added, (added) => {
			todos.push(this._createDocumentWithData(added));
		});
		_.forEach(diffJson.changed, (changed) => {
			const id = parseInt(changed.key[0]);
			_.forEach(changed.fields, (v, k) => {
				todos.push(this._updateDocumentWithData(id, { k: v.to }));
			});
		});
		_.forEach(diffJson.removed, (removed) => {
			const id = parseInt(removed.id);
			todos.push(this._deleteDocumentWithId(id));
		});

		return Promise.all(todos);
	}

	_updateMetaForCSVFile(csvFilePath) {
		const bn = path.dirname(csvFilePath).split(path.sep).pop();
		const timestamp = parseInt(bn.split("_")[1]);
		return new Promise((resolve, reject) => {
			this._client.update({
				index: 'collection',
				type: 'meta',
				id: 1,
				body: {
					doc: {
						hasImportedCSV: true,
						lastCSVImportTimestamp: timestamp
					}
				}
			}, (error, response) => {
				if (error) reject(error);
				resolve(response);
			});
		});
	}

	/**
	 * Remove all collection objects from the collection index and the object type
	 * @return {Promise} Resolved when the elasticsearch request completes
	 */
	clearCollectionObjects() {
		if (!this._didInit) {
			throw new ESCollectionException("Must call init() before interacting with ESCollection object");
		}
		return new Promise((resolve, reject) => {
			this._client.update({
				index: 'collection',
				type: 'meta',
				id: 1,
				body: {
					doc: {
						hasImportedCSV: false,
						lastCSVImportTimestamp: 0
					}
				}
			}, (error, response) => {
				if (error) reject(error);
				this._client.deleteByQuery({
					index: 'collection',
					type: 'object',
					body: {
						query: {
							match_all: {}
						}
					}
				}, (error, response) => {
					if (error) reject(error);
					resolve(response);
				});
			});
		});
	}

	/**
	 * Must be called before trying to interact with the ES collection index. This
	 * will prepare the index by, for example, adding the collection metadata
	 * @return {Promise} Resolved when the elasticsearch request completes
	 */
	init() {
		this._didInit = true;
		return this._collectionMetadataExists().then((exists) => {
			if (!exists) {
				return this._createCollectionMetadata();
			}
		}, (error) => {
			throw error;
		});
	}

	syncESToCSV(csvFilePath) {
		if (!this._didInit) {
			throw new ESCollectionException("Must call init() before interacting with ESCollection object");
		}
		// TODO: Throw an error if you can't find this CSV
		this._getLastCSVName().then((res) => {
			const canDiff = (res !== null);
			if (canDiff) {
				const csvDir = path.resolve(path.dirname(csvFilePath), "..");
				const lastCSVFilePath = path.join(csvDir, res, "objects.csv");
				return doCSVKeysMatch(lastCSVFilePath, csvFilePath).then((res) => {
					if (res) {
						logger.info("CSV keys match");
					} else {
						logger.info("CSV keys do not match");
					}
					return res;
				});
			} else {
				logger.info("No previous CSV file has been imported --- initializing new ES index");
				return false;
			}
		}).then((tryToDiff) => {
			if (tryToDiff) {
				logger.info("Updating from previously imported CSV");
				return this._updateESWithCSV(csvFilePath);
			} else {
				logger.info(`Initializing with CSV ${csvFilePath}`);
				return this.clearCollectionObjects().then((res) => this._syncESWithCSV(csvFilePath));
			}
		});
	}
}
