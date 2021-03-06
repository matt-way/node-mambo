"use strict";

var assert = require('assert');

var Schema = require('../lib/schema'),
    fields = require('../lib/fields'),
    StringField = fields.StringField,
    StringSetField = fields.StringSetField,
    NumberField = fields.NumberField,
    NumberSetField = fields.NumberSetField,
    JSONField = fields.JSONField,
    DateField = fields.DateField,
    BooleanField = fields.BooleanField,
    IndexField = fields.IndexField;

describe('Schema', function(){
    it('should construct fields just using the classnames', function(){
        var s = new Schema('Song', 'song', 'id', {
            'id': NumberField,
            'title': StringField
        });

        assert.equal(typeof s.fields.id, 'object');
        assert.equal(s.fields.id.name, 'id');
        assert.equal(typeof s.fields.title, 'object');
        assert.equal(s.fields.title.name, 'title');
    });

    it('should handle all field types', function(){
        var s = new Schema('Song', 'song', ['id', 'created'], {
            'id': NumberField,
            'title': StringField,
            'created': DateField,
            'recent_loves': JSONField,
            'loved_ids': NumberSetField
        });
        assert.equal(typeof s.fields.id, 'object');
        assert.equal(typeof s.fields.title, 'object');
        assert.equal(typeof s.fields.created, 'object');
        assert.equal(typeof s.fields.recent_loves, 'object');
        assert.equal(typeof s.fields.loved_ids, 'object');
    });

    it('should import raw data and marshall properly', function(){
        var row = {
                'id': {'N': '1'},
                'title': {'S': 'Silence in a Sweater'},
                'created': {'N': 1351373348257},
                'recent_loves': {"S": '[{"username": "lucas"}]'},
                'loved_ids': {'NS': [1, 2, 3, 4]}
            },
            created = new Date(row.created.N),
            s = new Schema('Song', 'song', 'id', {
                'id': NumberField,
                'title': StringField,
                'created': DateField,
                'recent_loves': JSONField,
                'loved_ids': NumberSetField
            }),
            data = s.import(row);

        assert.equal(data.id, 1);
        assert.equal(data.title, 'Silence in a Sweater');
        assert.equal(data.created.toString(), created.toString());
        assert.equal(data.recent_loves.length, 1);
        assert.equal(data.loved_ids[0], 1);
    });

    it('should export data properly', function(){
        var row = {
                'id': '1',
                'title': 'Silence in a Sweater',
                'created': new Date(1351373348257),
                'recent_loves': [{"username": "lucas"}]
            },
            created = row.created,
            s = new Schema('Song', 'song', 'id', {
                'id': NumberField,
                'title': StringField,
                'created': DateField,
                'recent_loves': JSONField
            }),
            data = s.export(row);

        assert.equal(data.id.N, 1);
        assert.equal(data.title.S, 'Silence in a Sweater');
        assert.equal(data.created.N, created.getTime());
        assert.equal(data.recent_loves.S.length, JSON.stringify(row.recent_loves).length);
    });

    it('should exports/imports nulls correctly', function(){
        var schema = new Schema('Song', 'song', 'id', {
                'id': NumberField,
                'title': StringField,
                'created': DateField,
                'recent_loves': JSONField,
                'exists': BooleanField,
                'some_numbers': NumberSetField,
                'tags': StringSetField
            }), data, imported;

        data = schema.export({});

        assert(data.tags === undefined);
        assert(data.some_numbers === undefined);

        imported = schema.import(data);

        assert.equal(imported.id, 0);
        assert.equal(imported.title, null);
        assert.equal(imported.created, null);
        assert.deepEqual(imported.recent_loves, {});
        assert.equal(imported.exists, null);
        assert.deepEqual(imported.tags, []);
        assert.deepEqual(imported.some_numbers, []);
    });

    describe("Links", function(){
        it("should allow declaring links", function(){
            var schema = new Schema('Song', 'song', 'id', {
                    'id': NumberField,
                    'title': StringField
                }).linksTo('loves', 'song_id'),
                loveSchema = new Schema('Loves', 'loves', ['song_id', 'timestamp'], {
                    'song_id': NumberField,
                    'timestamp': NumberField
                });
            assert.deepEqual(schema.links, {'loves': 'song_id'});
        });
    });

    describe("Index Fields", function(){
        it("should allow declaring index fields", function(){
            var schema = new Schema('Song', 'song', 'id', {
                'id': NumberField,
                'title': StringField,
                'loves': NumberField,
                'loves-index': new IndexField('loves').project(['title'])
            });
            assert.equal(Object.keys(schema.indexes).length, 1, "Should have 1 index");

        });
    });
});