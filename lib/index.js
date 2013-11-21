"use strict";

var aws = require("aws-sdk"),
    async = require('async'),
    Query = require('./query'),
    UpdateQuery = require('./update-query'),
    Batch = require('./batch'),
    Schema = require('./schema'),
    fields = require('./fields'),
    Inserter = require('./inserter'),
    Scanner = require('./scan'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    magneto = require('magneto'),
    debug = require('debug')('mambo:model');

var instances = [];

// Models have many tables.
function Model(){
    this.connected = false;
    this.db = null;

    this.schemas = Array.prototype.slice.call(arguments, 0);
    this.schemasByAlias = {};

    this.schemas.forEach(function(schema){
        this.schemasByAlias[schema.alias] = schema;
    }.bind(this));

    this.tablesByName = {};

    debug('Reading schemas...');
    this.schemas.forEach(function(schema){
        this.schemasByAlias[schema.alias] = schema;
    }.bind(this));

    this.setTablePrefix(this.prefix || '');

    instances.push(this);

    if(module.exports.lastConnection){
        this.conect.apply(this, module.exports.lastConnection);
    }
}
util.inherits(Model, EventEmitter);

Model.prototype.setTablePrefix = function(prefix){
    this.prefix = prefix;
    this.schemas.forEach(function(schema){
        var oldTableName = schema.tableName;
        delete this.tablesByName[oldTableName];
        schema.tableName = (prefix || '') + schema.tableName;
        this.tablesByName[schema.tableName] = schema;
    }.bind(this));
    return this;
};

// Grab a schema definition by alias.
Model.prototype.schema = function(alias){
    var s = this.schemasByAlias[alias];
    if(!s){
        throw new Error('Counldn\'t find schema for `'+alias+
            '`.  Did you mistype or forget to register your schema?');
    }
    return s;
};

Model.prototype.tableNameToAlias = function(name){
    return this.tablesByName[name].alias;
};

// Fetch a query wrapper Django style.
Model.prototype.objects = function(alias, hash, range, done){
    if(typeof range === 'object'){
        var key = Object.keys(range)[0],
            q = new Query(this, alias, hash);

        q.fetch(function(err, results){
            if(err){
                return done(err);
            }
            done(null, results.filter(function(res){
                return res[key] === range[key];
            })[0]);
        });

    }
    else{
        return new Query(this, alias, hash, range);
    }
};

// Model.insert('user', data, function(err, res){});
Model.prototype.insert = function(alias, data, fn){
    var i =  new Inserter(this, alias);
    if(data){
        i.set(data);
    }
    if(fn){
        i.commit(fn);
    }
    return i;
};

// Model.update('user', 1, {sets}, function(err, res){});
Model.prototype.update = function(alias, hash, range, data, fn){
    var q =  new UpdateQuery(this, alias, hash);
    if(typeof data === 'function'){
        fn = data;
        data = range;
        range = undefined;
    }

    if(range){
        q.range = range;
    }
    if(data){
        q.set(data);
    }

    if(fn){
        q.commit(fn);
    }
    return q;
};

Model.prototype.batch = function(){
    return new Batch(this);
};


// Actually connect to dynamo or magneto.
Model.prototype.getDB = function(key, secret){
    if(this.db !== null){
        return this.db;
    }

    var self = this;
    debug('Dynamo client created.');

    if(process.env.MAMBO_BACKEND === "magneto"){
        debug('Using magneto');
        magneto.patchClient(aws, process.env.MAGNETO_PORT || 8081);
        debug('Connected to magneto on localhost:' + ( process.env.MAGNETO_PORT || 8081));
    }
    else {
        if(!key || !secret){
            debug('Warning: Calling connect without key/secret?');
        }
        else {
            aws.config.update({'accessKeyId': key, 'secretAccessKey': secret});
        }
    }

    this.db = new aws.DynamoDB();
    // @todo (lucas) these need reimplemented.
    // this.db.on('retry', function(req){
    //     self.emit('retry', req);
    // })
    // .on('successful retry', function(req){
    //     self.emit('successful retry', req);
    // })
    // .on('retries exhausted', function(req){
    //     self.emit('retries exhausted', req);
    // })
    // .on('stat', function(data){
    //     self.emit('stat', data);
    // });
    return this.db;
};

Model.prototype.connect = function(key, secret, prefix, region){
    debug('Connecting...');
    var self = this;

    key = key || process.env.AWS_ACCESS_KEY;
    secret = secret || process.env.AWS_SECRET_KEY;
    region = region || process.env.AWS_REGION || 'us-east-1';
    prefix = prefix || process.env.MAMBO_PREFIX || '';

    this.prefix = prefix;
    this.region = region;
    this.getDB(key, secret);

    this.connected = true;
    debug('Ready.  Emitting connect.');

    this.emit('connect');
    return this;
};

// Create all tables as defined by this models schemas.
Model.prototype.createAll = function(done){
    var self = this;
    debug('createAll called', this.schemasByAlias);
    async.parallel(Object.keys(this.schemasByAlias).map(function(alias){
        return function(callback){
            self.ensureTableExists(alias, callback);
        };
    }), done);
};

// Check if a table already exists.  If not, create it.
Model.prototype.ensureTableExists = function(alias, done){
    var self = this;
    debug('Making sure table `' + alias + '` exists');

    this.getDB().listTables(function(err, data){
        if(err){
            return done(err);
        }

        if(data.TableNames.indexOf(self.schema(alias).tableName) !== -1){
            debug('Table already exists ' + alias);
            return done(null);
        }

        debug('Table doesnt exist.  Creating...');

        self.createTable(alias, 1, 1, done);
    });
};

// Low level get item wrapper.
// Params:
// - alias: The table alias name
// - hash: the value of the key-hash of the object you want to retrieve, eg:
// - the song ID
// - range: the value of the key-range of the object you want to retrieve
// - attributesToGet: An array of names of attributes to return in each
// - object. If empty, get all attributes.
// - consistentRead: boolean
Model.prototype.get = function(alias, hash, range, attrs, consistent, done){
    if(!done){
        var args = Array.prototype.slice.apply(arguments);
        for(var i = 0; i < args.length; i++){
            if(typeof args[i] === 'function'){
                done = args[i];
            }
        }
    }

    var schema = this.schema(alias),
        self = this,
        request;

    // Assemble the request data
    request = {
        'TableName': schema.tableName,
        'Key': schema.exportKey(hash, range)
    };

    if(attrs && attrs.length > 0){
        request.AttributesToGet = attrs;
    }

    if(consistent){
        request.ConsistentRead = consistent;
    }

    this.getDB().getItem(request, function(err, data){
        if(err){
            return done(err);
        }
        return done(null, (data.Item !== undefined) ?
                self.schema(alias).import(data.Item) : null);
    });
};

Model.prototype.remove = function(alias, hash, range, done){
    var opts = {};
    if(typeof range === 'function'){
        done = range;
        range = undefined;
    }

    if(range){
        opts.range = range;
    }
    this.delete(alias, hash, opts, done);
};

// Lowlevel delete item wrapper
// example:
//     delete('alias', 'hash', {
//          'range': 'blahblah',
//          'expectedValues': [{
//              'attributeName': 'attribute_name',
//              'expectedValue': 'current_value', // optional
//              'exists': 'true' // defaults to true
//            }],
//          'returnValues':  'NONE'
//        })
// @todo (lucas) this should be more like Model.prototype.get
Model.prototype.delete = function(alias, hash, opts, done){
    opts = opts || {};

    debug('Delete `'+alias+'` with hash `'+hash+'` and range `'+opts.range+'`');

    var self = this,
        schema = this.schema(alias),
        request = {
            'TableName': schema.tableName,
            'Key': schema.exportKey(hash, opts.range),
            'ReturnValues': opts.returnValues || 'NONE'
        };

    // Add expectedValues for conditional delete
    if(opts.expectedValues){
        request.Expected = {};
        opts.expectedValues.forEach(function(attr){
            var expectedAttribute = {
                    'Exists': attr.exists || Number(true)
                },
                field = schema.field(attr.attributeName);

            if (attr.expectedValue) {
                expectedAttribute.Value = {};
                expectedAttribute.Value[field.type] = field.export(attr.expectedValue);
            }
            request.Expected[attr.attributeName] = expectedAttribute;
        });
    }

    // Make the request
    this.getDB().deleteItem(request, function(err, data){
        if(err){
            return done(err);
        }
        self.emit('delete', [alias, hash, opts.range]);
        done(null, data);
    });
};

// TODO: take range/secondary index into consideration to avoid same hash overwriting
var sortObjects = function(objects, values, property){
    property = property || 'id';

    var objectMap = {},
        i = 0;

    for(i=0; i < objects.length; i++){
        objectMap[objects[i][property]] = objects[i];
    }

    return values.map(function(value){
        return objectMap[value] || null;
    }).filter(function(o){
        return o !== null;
    });
};


// Accepts an array of objects
// Each object should look like this:
// {
//     'alias': 'url',
//     'hashes': [2134, 1234],
//     'ranges': [333333, 222222],
//     'attributesToGet': ['url']
// }
// alias is the table alias name
// hashes is an array of key-hashes of objects you want to get from this table
// ranges is an array of key-ranges of objects you want to get from this table
// only use ranges if this table has ranges in its key schema
// hashes and ranges must be the same length and have corresponding values
// attributesToGet is an array of the attributes you want returned for each
// object. Omit if you want the whole object.

// Example:
// To get the urls of songs 1, 2, and 3 and the entire love objects for
// love 98 with created value 1350490700640 and love 99 with 1350490700650:
// [
//     {
//         'alias': 'song',
//         'hashes': [1, 2, 3],
//         'attributesToGet': ['url']
//     },
//     {
//         'alias': 'loves',
//         'hashes': [98, 99],
//         'ranges': [1350490700640, 1350490700650]
//     },
// ]
// @todo (lucas) This would be better if req was a map of `alias` to items.
Model.prototype.batchGet = function(req, done){
    debug('Batch get ' + util.inspect(req, false, 5));
    var request = {
            'RequestItems': {}
        },
        results = {},
        schema,
        obj,
        self = this;

    // Assemble the request data
    req.forEach(function(item){
        item.ranges = item.ranges || [];

        schema = self.schema(item.alias);
        request.RequestItems[schema.tableName] = {'Keys': []};
        request.RequestItems[schema.tableName].Keys = item.hashes.map(function(hash, index){
            return schema.exportKey(hash, item.ranges[index]);
        });

        // Add attributesToGet
        if(item.attributesToGet){
            request.RequestItems[schema.tableName].AttributesToGet = item.attributesToGet;
        }
    });

    debug('Built BATCH_GET request: ' + util.inspect(request, false, 5));

    // Make the request
    this.getDB().batchGetItem(request, function(err, data){
        if(err){
            return done(err);
        }

        // translate the response from dynamo format to exfm format
        req.forEach(function(tableData){
            var schema = self.schema(tableData.alias),
                items = data.Responses[schema.tableName].Items || data.Responses[schema.tableName];

            results[tableData.alias] = items.map(function(item){
                return schema.import(item);
            });

            // Sort the results
            // TODO: Bug in sort with objects grabbed with same hash and different range key
            // leave unsorted for the time being
            /*
            results[tableData.alias] = sortObjects(results[tableData.alias],
                tableData.hashes, schema.hash);
            */

        });
        done(null, results);
    });
};


// this.batchWrite(
//     {
//         'song': [
//             {
//                 'id': 1,
//                 'title': 'Silence in a Sweater'
//             },
//             {
//                 'id': 2,
//                 'title': 'Silence in a Sweater (pt 2)'
//             },
//         ]
//     },
//     {
//         'song': [
//             {'id': 3}
//         ]
//     }
// );
Model.prototype.batchWrite = function(puts, deletes, done){
    debug('Batch write: puts`'+util.inspect(puts, false, 10)+'`, deletes`'+util.inspect(deletes, false, 10)+'` ');
    var self = this,
        req = {
            'RequestItems': {}
        },
        totalOps = 0;

    Object.keys(puts).forEach(function(alias){
        var schema = self.schema(alias);

        if(!req.RequestItems.hasOwnProperty(schema.tableName)){
            req.RequestItems[schema.tableName] = [];
        }
        puts[alias].forEach(function(put){
            req.RequestItems[schema.tableName].push({
                'PutRequest': {
                    'Item': schema.export(put)
                }
            });
            totalOps++;
        });
    });

    Object.keys(deletes).forEach(function(alias){
        var schema = self.schema(alias);

        if(!req.RequestItems.hasOwnProperty(schema.tableName)){
            req.RequestItems[schema.tableName] = [];
        }

        deletes[alias].forEach(function(del){
            var range = schema.range ? del[schema.range] : undefined;
            req.RequestItems[schema.tableName].push({
                'DeleteRequest': {
                    'Key': schema.exportKey(del[schema.hash], range)
                }
            });
            totalOps++;
        });
    });

    if(totalOps > 25){
        throw new Error(totalOps + ' is too many for one batch!');
    }

    this.getDB().batchWriteItem(req, function(err, data){
        if(err){
            return done(err);
        }
        var success = {};
        if(data.Responses){
            Object.keys(data.Responses).forEach(function(tableName){
                success[self.tableNameToAlias(tableName)] = data.Responses[tableName].ConsumedCapacityUnits;
            });
        }
        done(null, {'success': success,'unprocessed': data.UnprocessedItems});
    });
};

// http://docs.amazonwebservices.com/amazondynamodb/latest/developerguide/API_PutItem.html

// alias: The table alias name

// obj: The object to put in the table. This method will handle formatting
// the object and casting.
// Sample:
// {
//     "url":"http://thissongexistsforreallzz.com/song1.mp3",
//     "id":30326673248,
//     "url_md5":"66496db3a1bbba45fb189030954e78d0",
//     "metadata_state":"pending",
//     "loved_count":0,
//     "listened":0,
//     "version":1,
//     "created":1350500174375
// }
//

// expected: See AWS docs for an explanation. This method handles casting
// and supplying the attribute types, so this object is somewhat simplified
// from what AWS accepts.
// Sample:
// {
//     'metadata_state': {'Value': 'pending', 'Exists': true},
//     'version': {'Value': 0, 'Exists': true}
// }
// returnValues: See AWS docs for an explanation.
Model.prototype.put = function(alias, obj, expected, returnOldValues, done){
    debug('Put `'+alias+'` '+ util.inspect(obj, false, 10));
    var self = this,
        request,
        schema = this.schema(alias),
        clean = schema.export(obj);

    request = {'TableName': schema.tableName, 'Item': schema.export(obj)};

    if(expected && Object.keys(expected).length > 0){
        request.Expected = {};
        Object.keys(expected).forEach(function(key){
            var field = schema.field(key);
            request.Expected[key] = {};
            request.Expected[key].Exists = expected[key].Exists;
            if(expected[key].Value !== undefined){
                request.Expected[key].Value = {};
                request.Expected[key].Value[field.type] = field.export(expected[key].Value);
            }
        });
    }

    if(returnOldValues === true){
        request.ReturnValues = "ALL_OLD";
    }

    // Make the request
    this.getDB().putItem(request, function(err, data){
        if(err){
            return done(err);
        }
        self.emit('insert', {
            'alias': alias,
            'expected': expected,
            'data': obj
        });
        done(null, obj);
    });
};

// usage:
// update('alias', 'hash', [{
//      'attributeName': 'attribute_name'
//      'newValue': 'new_value',
//      'action': 'PUT'
//    }], {
//      'range': 'blahblah',
//      'expectedValues': [{
//          'attributeName': 'attribute_name',
//          'expectedValue': 'current_value', // optional
//          'exists': 'true' // defaults to true
//        }],
//      'returnValues':  'NONE'
//    })
Model.prototype.updateItem = function(alias, hash, attrs, opts, done){
    opts = opts || {};

    debug('Update `'+alias+'` with hash `'+hash + '`' +
        ((opts.range !== undefined) ? ' and range `'+opts.range+'` ': ' ') +
        ' do => ' + util.inspect(attrs, false, 5));

    var self = this,
        response = [],
        schema = this.schema(alias),
        request = {
            'TableName': schema.tableName,
            'Key': schema.exportKey(hash, opts.range),
            'AttributeUpdates': {},
            'ReturnValues': opts.returnValues || 'NONE'
        },
        obj,
        expectedAttributes = {},
        expectedAttribute = {};


    // Add attributeUpdates
    attrs.forEach(function(attr){
        // if(attr.attributeName != schema.hash && attr.attributeName != schema.range){
            var field = schema.field(attr.attributeName),
                attributeUpdate = {
                    'Action': attr.action || 'PUT'
                };
            if(!field){
                throw new Error('Unknown field ' + attr.attributeName);
            }

            if(attr.newValue !== undefined){
                attributeUpdate.Value = {};
                attributeUpdate.Value[field.type] = field.export(attr.newValue);
            }

            request.AttributeUpdates[attr.attributeName] = attributeUpdate;
        // }
    }.bind(this));

    // Add expectedValues for conditional update
    if(opts.expectedValues !== undefined){
        request.Expected = {};
        opts.expectedValues.forEach(function(attr){
            var field = schema.field(attr.attributeName);
            expectedAttribute = {
                'Exists': Number(attr.exists).toString()
            };
            if (attr.expectedValue) {
                expectedAttribute.Value = {};
                expectedAttribute.Value[field.type] = field.export(attr.expectedValue);
            }

            request.Expected[attr.attributeName] = expectedAttribute;
        });
    }

    // Make the request
    this.getDB().updateItem(request, function(err, data){
        if(err){
            return done(err);
        }
        self.emit('update', {
            'alias': alias,
            'range': opts.range,
            'updates': attrs,
            'options': opts
        });
        if (opts.returnValues !== undefined) {
            return done(null, schema.import(data.Attributes));
        }
        done(null, data);
    });
};

// usage:
// query('alias', 'hash', {
//     'limit': 2,
//     'consistentRead': true,
//     'scanIndexForward': true,
//     'conditions': {
//         'blah': {'GT': 'some_value'}
//     },
//     'exclusiveStartKey': {
//         'hashName': 'some_hash',
//         'rangeName': 'some_range'
//     },
//     'attributeToGet':  ['attribute'],
//     'count': true
// })
Model.prototype.query = function(alias, hash, opts, done){
    opts = opts || {};

    debug('Query `'+alias+'` with hash `'+hash+'` and range `'+opts.range+'`');
    debug('Query options: ' + util.inspect(opts, false, 5));

    var response = [],
        schema = this.schema(alias),
        request = {
            'TableName': schema.tableName,
            'KeyConditions': {}
        },
        obj,
        hashKey = {},
        rangeKey = {},
        attributeValueList = [],
        attributeValue = {},
        exclusiveStartKey = {},
        attr,
        dynamoType,
        filteredItem,
        hashField = schema.field(schema.hash);

    function addKeyCondition(key, op, vals){
        var field = schema.field(key);
        if(!Array.isArray(vals)){
            vals = [vals];
        }

        request.KeyConditions[key] = {
            'AttributeValueList': [],
            'ComparisonOperator': op
        };
        vals.forEach(function(val){
            var i = {};
            i[field.type] = field.export(val);
            request.KeyConditions[key].AttributeValueList.push(i);
        });
    }

    addKeyCondition(schema.hash, 'EQ', hash);

    if(opts.conditions){
        Object.keys(opts.conditions).forEach(function(key){
            var field = schema.field(key),
                op = Object.keys(opts.conditions[key])[0],
                vals = opts.conditions[key][op];
            addKeyCondition(key, op, vals);
        });
    }

    if(opts.index){
        request.IndexName = opts.index;
    }

    if(opts.count === true){
        request.Select = 'COUNT';
    }

    // Add Limit
    if(opts.limit !== undefined){
        request.Limit = Number(opts.limit);
    }

    // Add ConsistentRead
    if(opts.consistentRead){
        request.ConsistentRead = opts.consistentRead;
    }

    // Add ScanIndexForward
    if(opts.scanIndexForward !== undefined){
        request.ScanIndexForward = opts.scanIndexForward;
    }

    // Add ExclusiveStartKey
    if(opts.exclusiveStartKey !== undefined){
        hashKey[schema.hashType] = opts.exclusiveStartKey.hashName.toString();
        request.ExclusiveStartKey.HashKeyElement = hashKey;
        if(opts.exclusiveStartKey.range !== undefined){
            rangeKey[schema.rangeType] = opts.exclusiveStartKey.rangeName.toString();
            request.ExclusiveStartKey.RangeKeyElement = rangeKey;
        }
    }

    // Add AttributesToGet
    if(opts.attributesToGet !== undefined){
        request.AttributesToGet = opts.attributesToGet;
    }

    // Make the request
    this.getDB().query(request, function(err, data){
        if(err){
            return done(err);
        }

        done(null, data.Items.map(function(item){
            // Cast the raw data from dynamo
            item = schema.import(item);
            if(opts.attributesToGet){
                // filter out attributes not in attributesToGet
                filteredItem = {};
                Object.keys(item).forEach(function(key){
                    if(opts.attributesToGet.indexOf(key) !== -1){
                        filteredItem[key] = item[key];
                    }
                });
                item = filteredItem;
            }
            return item;
        }), data.Count);
    });
};

Model.prototype.scan = function(alias){
    return new Scanner(this, alias);
};


Model.prototype.runScan = function(alias, filter, opts, done){
    var self = this,
        schema = this.schema(alias),
        req = {
            'TableName': schema.tableName,
            'ScanFilter': {}
        };

    if(opts.limit !== undefined){
        req.Limit = opts.limit;
    }

    if(opts.startKey !== undefined){
        req.ExclusiveStartKey = schema.exportKey(opts.startKey);
    }

    if(opts.count !== undefined && opts.fields !== undefined){
        return done(new Error('Can\'t specify count and fields in the same scan'));
    }

    if(opts.count !== undefined){
        req.Count = opts.count;
    }

    if(opts.fields !== undefined){
        req.AttributesToGet =  opts.fields;
    }

    Object.keys(filter).forEach(function(key){
        var f = new Scanner.Filter(schema, key, filter[key]);
        req.ScanFilter[key] = f.export();
    });

    // Make the request
    this.getDB().scan(req, function(err, data){
        if(err){
            return done(err);
        }
        done(null, new Scanner.ScanResult(self, alias, data, filter, opts));
    });
};


Model.prototype.waitForTableStatus = function(alias, status, done){
    var self = this,
        tableName = this.schema(alias).tableName;

    this.getDB().describeTable({'TableName': tableName}, function(err, data){
        if(status === 'DELETED' && !data){
            return done(null, true);
        }
        if(data && data.Table.TableStatus === status){
            return done(null, true);
        }
        setTimeout(function(){
            self.waitForTableStatus(alias, status, done);
        }, 50);
    });
};

Model.prototype.waitForTableDelete = function(alias){
    return this.waitForTableStatus(alias, 'DELETED');
};

Model.prototype.waitForTableCreation = function(alias){
    return this.waitForTableStatus(alias, 'ACTIVE');
};

Model.prototype.deleteTable = function(alias, done){
    var self = this;
    debug('delete table', alias);
    this.getDB().deleteTable({
        'TableName': this.schema(alias).tableName
    }, function(err, res){
        debug('table deleted', alias);
        self.emit('delete table', alias);
        done(err, res);
    });
};

// @todo (lucas) Needs to happen on a queue if we're not using magneto.
Model.prototype.createTable = function(alias, read, write, done){
    read = read || 10;
    write = write || 10;

    var schema = this.schema(alias),
        self = this,
        params = {
            'TableName': schema.tableName,
            'AttributeDefinitions': schema.getAttributeDefinitions(),
            'KeySchema': schema.getKeySchema(),
            // 'LocalSecondaryIndexes': [],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': read,
                'WriteCapacityUnits': write
            }
        };

    debug('creating table for alias `'+alias+'`', params);

    this.getDB().createTable(params, function(err, res){
        debug('create table for alias `'+alias+'` result', err, res);
        self.emit('create table', alias, read, write);
        done(err, res);
    });
};

Model.prototype.updateHash = function(alias, oldHash, newHash, includeLinks, done){
    var self = this,
        schema = self.schema(alias);

    function exec(batch){
        if(!batch){
            batch = self.batch();
        }
        return self.get(alias, oldHash, function(err, obj){
            obj[schema.hash] = newHash;
            batch.remove(alias, oldHash)
                .insert(alias, obj)
                .commit(done);
        });
    }
    if(includeLinks){
        return this.updateLinks(alias, oldHash, newHash, true, function(err){
            if(err){
                return done(err);
            }
            exec();
        });
    }
    return exec();
};

Model.prototype.updateLinks = function (alias, oldHash, newHash, done){
    var self = this,
        schema = self.schema(alias),
        batch = self.batch();

    debug('Updating links for `'+alias+'` from `'+oldHash+'` to `'+newHash+'`');
    if(Object.keys(schema.links).length === 0){
        return done(new Error('No links for `'+alias+'`.  Did you mean to call this?'));
    }
    debug('Links: ' + util.inspect(schema.links));

    async.parallel(Object.keys(schema.links).map(function(linkAlias){
        return function(callback){
            debug('Getting all `'+alias+'` links to `'+linkAlias+'`');
            var linkKey = schema.links[linkAlias],
                rangeKey = Schema.get(linkAlias).range;

            self.objects(linkAlias, oldHash).fetch(function(err, docs){
                if(err){
                    return callback(err);
                }
                debug('Got ' + docs.length + ' links');
                docs.map(function(doc){
                    doc[linkKey] = newHash;
                    if(rangeKey){
                        batch.remove(linkAlias, oldHash, doc[rangeKey]);
                    }
                    else{
                        batch.remove(linkAlias, oldHash);
                    }
                    batch.insert(linkAlias, doc);
                });
                callback();
            });
        };
    }), function(err){
        if(err){
            return done(err);
        }
        batch.commit(done);
    });
};

module.exports.Model = Model;
module.exports.Schema = Schema;
Object.keys(fields).forEach(function(fieldName){
    module.exports[fieldName] = fields[fieldName];
});
module.exports.instances = instances;
module.exports.lastConnection = null;

module.exports.connect = function(key, secret, prefix, region){
    module.exports.lastConnection = [key, secret, prefix, region];

    instances.forEach(function(instance){
        instance.connect(key, secret, prefix, region);
    });
};

module.exports.setTablePrefix = function(prefix){
    instances.forEach(function(instance){
        instance.setTablePrefix(prefix);
    });

    // So any newly created models also get the prefix.
    Model.prototype.prefix = prefix;
};

module.exports.createAll = function(done){
    debug('create all instances', instances);
    async.parallel(instances.map(function(instance){
        return function(callback){
            instance.createAll(callback);
        };
    }), done);
};

module.exports.testing = require('./plugins/testing');

module.exports.use = function(fn){
    if(fn){
        fn();
    }
};

