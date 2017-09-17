/**
 * Created by Lyall, 14/9/2017
 */

const FS = require('fs');
const PATH = require('path');
const UTIL = require('util');
const { packageName } = require('../package.json');

const DL = UTIL.debuglog(packageName);
const debuglog = (...params) => {
    DL(`[${packageName}]`, ...params);
};

const mkdir = (dirpath) => {
    if (!dirpath || typeof dirpath !== 'string') return;
    let path = '/';
    dirpath.split('/').forEach((dir) => {
        path = PATH.join(path, dir);
        if (!FS.existsSync(path)) {
            try {
                FS.mkdirSync(path);
            } catch (e) {
                debuglog(`Error when creating workdir [${path}]`, e);
            }
        }
    });
};

const parseProcQueueItem = (itemName) => {
    if (!itemName) return { timestamp: NaN, processTag: '' };
    return {
        timestamp: Number(itemName.substr(0, itemName.indexOf('-'))),
        processTag: itemName.substr(itemName.indexOf('-') + 1),
    };
};

const safeKey = (key) => {
    if (!key || typeof key !== 'string') return null;
    return key.replace(/\//g, '|||').replace(/#/g, '___').replace(/&/g, ':::');
}

const originalKey = (safeKey) => {
    if (!safeKey || typeof safeKey !== 'string') return null;
    return safeKey.replace(/___/g, '#').replace(/\|\|\|/g, '\\').replace(/:::/g, '&');
}

class Cache {
    constructor(options) {
        this.options = Object.assign({
            useFileCache: false,
            useMemCache: true,
            workdir: PATH.join(process.cwd(), 'tmp/cache'),
            processTag: `${Date.now()}.${process.pid}`,
            heartbeatTimeout: 1000, // In milliseconds
            maxTTL: 86400 * 1000 * 7, // Max ttl of data produced by dead processes
        }, options);
        this.options.procHeartDir = PATH.join(this.options.workdir, 'proc');
        this.options.procQueueDir = PATH.join(this.options.workdir, 'queue');
        this.options.dataDir = PATH.join(this.options.workdir, 'data');
        this.options.heartbeatPath = PATH.join(this.options.procHeartDir, this.options.processTag);
        this.options.heartbeatInterval = Math.round(this.options.heartbeatTimeout / 3);

        this.heartbeatInstance = null;
        this.queue = null;
        this.isProcessingQueue = false;
        this.cache = {};
    }

    async init() {
        // Initialize file cache
        const self = this;
        return new Promise((resolve) => {
            if (self.options.useFileCache) {
                self.queue = [];
                // Create the file cache work area
                [
                    self.options.workdir,
                    self.options.procHeartDir,
                    self.options.procQueueDir,
                ].forEach(dir => mkdir(dir));
                // Start heartbeat
                self.heartbeat();
                // Start the watcher of operation queue
                FS.watch(self.options.procQueueDir, self.queuedirHandler.bind(self));
                // Make sure other processes can finish initiation
                setTimeout(() => {
                    resolve(true);
                }, self.options.heartbeatTimeout);
            } else {
                resolve(true);
            }
        });
    }

    // Operation queue handlers
    queuedirHandler(type, filename) {
        const item = parseProcQueueItem(filename);
        if (item.processTag !== this.processTag) {
            this.processJobQueue();
        }
    }

    processJobQueue({ isInitialization = false }) {
        // 
        // No matter what kind of job
        // The process must queue itself to get control of the storage
        // If there is no other processes alive, then no need to wait
        // If Write a message into the process queue
        if (isInitialization) {
            // Enqueue the process
            FS.writeFileSync(PATH.join(this.options.procQueueDir, `${Date.now()}-${this.options.processTag}`), '1');
        }
        // Read the queue to check whether current process is at the top
        const procQueue = FS.readdirSync(this.options.procQueueDir);
        if (procQueue.length > 1) {
            let top = 0;
            let min = -1;
            // No need to sort, the top one item is ok
            for (let i = 0; i < procQueue.length; i++) {
                procQueue[i] = parseProcQueueItem(procQueue[i]);
                if (min < 0 || procQueue[i].timestamp < min) {
                    min = procQueue[i].timestamp;
                    top = i;
                }
            }
            const topProc = procQueue[top];
            if (topProc.processTag === this.options.processTag) {
                // The current process is at the top of the queue
                // Process the job
                const job = this.dequeue();
                const self = this;
                job.callback = (error, response) => {
                    // When the job finished, remove the process queue
                    try {
                        FS.unlinkSync(PATH.join(self.options.procQueueDir, `${topProc.timestamp}-${topProc.processTag}`));
                    } catch (e) {
                        debuglog(
                            'Error when removing queue item from process queue dir:',
                            PATH.join(self.options.procQueueDir, `${topProc.timestamp}-${topProc.processTag}`),
                            e,
                        );
                    }
                    // invoke the callback of the job
                    job.callback(error, response);
                };
                // TODO: Do the job
                this.processJob(job);
            }
        }
    }

    // Read/write job
    processJob(job) {
        // Job item format: { type: 'GET/SET/RESET', key, value, ttl, arriveAt, callback }
        // data file name format: { arriveAt, data: {}, ttl, processTag }
        if (!job || typeof job !== 'object' || !job.type) return;
        let filepath = PATH.join(this.options.dataDir, safeKey(job.key));
        let item = null;
        try {
            switch (job.type) {
                case 'GET':
                    item = JSON.parse(FS.readFileSync(filepath));
                    if (Date.now() - Number(item.arriveAt) > (Number(item.ttl) || this.options.maxTTL)) {
                        // Remove the data from disk
                        FS.unlinkSync(filepath);
                        job.callback(null, null);
                    } else {
                        job.callback(null, item.data);
                    }
                    break;
                case 'SET':
                    item = {
                        arriveAt: job.arriveAt,
                        data : item.value,
                        processTag: this.processTag,
                    };
                    if (typeof job.ttl !== 'undefined') {
                        item.ttl = job.ttl;
                    }
                    FS.writeFileSync(filepath, JSON.stringify(item));
                    job.callback(null, true);
                    break;
                case 'RESET':
                    FS.unlinkSync(filepath);
                    job.callback(null, true);
                    break;
                default:
                    job.callback(`Unknown type of cache operation: ${job.type}`);
                    break;
            }
        } catch(e) {
            job.callback(e);
        }
    }

    // Clear dead/illegal process
    healthCheck() {
        try {
            const procs = FS.readdirSync(this.options.procHeartDir);
            const self = this;
            const aliveprocs = {};
            if (Array.isArray(procs) && procs.length > 0) {
                const self = this;
                procs.forEach((processTag) => {
                    const procheart = PATH.join(self.options.procHeartDir, processTag);
                    const timestamp = Number(FS.readFileSync(procheart));
                    if (Date.now() - timestamp < self.options.heartbeatTimeout) {
                        aliveprocs[processTag] = timestamp;
                    } else {
                        // Clear dead process heart
                        FS.unlinkSync(procheart);
                    }
                });
            }
            // Clear dead/illegal processes from the queue
            const queue = FS.readdirSync(this.options.procQueueDir);
            if (Array.isArray(queue) && queue.length > 0) {
                queue.forEach((job) => {
                    const processTag = job.split('-')[1];
                    if (!aliveprocs[processTag]) {
                        FS.unlinkSync(PATH.join(self.options.procQueueDir, job));
                    }
                });
            }
            // Clear data produced by dead processes
            const datalist = FS.readdirSync(this.options.dataDir);
            datalist.forEach(itemKey => {
                const filepath = PATH.join(self.options.dataDir, itemKey);
                const data = JSON.parse(FS.readFileSync(filepath));
                if (!aliveprocs[data.processTag]) {
                    if (Date.now() - Number(data.arriveAt) > (Number(data.ttl) || self.options.maxTTL)) {
                       FS.unlinkSync(filepath); 
                    }
                }
            })
        } catch (e) {
            debuglog('Error when checking health', e);
        }
    }

    // To indicate this process is still alive
    // And clear the dead/illegal process out from the queue
    heartbeat() {
        try {
            FS.writeFileSync(this.options.heartbeatPath, Date.now());
            this.healthCheck();
            if (!this.heartbeatInstance) {
                this.heartbeatInstance = setInterval(
                    this.heartbeat.bind(this),
                    this.options.heartbeatInterval,
                );
            }
        } catch (e) {
            debuglog('Error when heartbeating', e);
        }
        return this.heartbeatInstance;
    }

    // File cache queue operations
    enqueue(job) {
        this.queue.push(job);
        this.processJobQueue();
    }

    dequeue() {
        return this.queue.shift();
    }

    // Cache interfaces
    async get(key) {
        if (this.useMemCache && typeof this.cache[key] !== 'undefined') {
            return this.cache[key];
        } else if (this.useFileCache) {
            const self = this;
            return new Promise((resolve, reject) => {
                const job = {
                    type: 'GET',
                    key,
                    arriveAt: Date.now(),
                    callback: (error, data) => {
                        if (error) reject(error);
                        else resolve(data);
                    },
                };
                self.enqueue(job);
            });
        }
        return null;
    }

    async set(key, value, ttl) {
        if (this.useFileCache) {
            const self = this;
            return new Promise((resolve, reject) => {
                const job = {
                    type: 'SET',
                    key,
                    value,
                    ttl,
                    arriveAt: Date.now(),
                    callback: (error, feedback) => {
                        if (error) reject(error);
                        else {
                            if (self.useMemCache) {
                                self.cache[key] = value;
                            }
                            if (typeof ttl === 'number' && ttl > 0) {
                                setTimeout(async () => {
                                    await self.reset(key);
                                }, ttl);
                            }
                            resolve(feedback);
                        }
                    },
                };
                self.enqueue(job);
            });
        } else if (this.useMemCache) {
            this.cache[key] = value;
            if (typeof ttl === 'number' && ttl > 0) {
                const self = this;
                setTimeout(async () => {
                    await self.reset(key);
                }, ttl);
            }
        }
        return true;
    }

    async reset(key) {
        if (this.useMemCache && typeof this.cache[key] !== 'undefined') {
            delete this.cache[key];
        }

        if (this.useFileCache) {
            const self = this;
            return new Promise((resolve, reject) => {
                const job = {
                    type: 'RESET',
                    key,
                    arriveAt: Date.now(),
                    callback: (error, feedback) => {
                        if (error) reject(error);
                        else resolve(feedback);
                    },
                };
                self.enqueue(job);
            });
        }

        return true;
    }
}

module.exports = Cache;