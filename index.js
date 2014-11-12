var protocol = require('bcoin-protocol')
var bTx = require('bcoin-tx')
var utils = require('bcoin-utils')

function Block(network, data, subtype) {
    if (!(this instanceof Block)) return new Block(network, data, subtype);

    network = network || 'mainnet'
    this.parser = protocol.parser(network)

    this.type = 'block';
    this.subtype = subtype;
    this.version = data.version;
    this.prevBlock = utils.toHex(data.prevBlock);
    this.merkleRoot = utils.toHex(data.merkleRoot);
    this.ts = data.ts;
    this.bits = data.bits;
    this.nonce = data.nonce;
    this.totalTX = data.totalTX;
    this.hashes = (data.hashes || []).map(function(hash) {
        return utils.toHex(hash);
    });
    this.flags = data.flags || [];

    // List of matched TXs
    this.tx = [];
    this.invalid = false;

    if (this.subtype === 'block') {
        var self = this;
        this.txs = data.txs || [];
        this.txs = this.txs.map(function(t) {
            t = bTx(network, t, self);
            t.block = self.hash('hex');
            t.ts = t.ts || self.ts;
            return t;
        });
        this.tx = this.txs.map(function(tx) {
            return tx.hash('hex');
        });
        this.invalid = !this._checkBlock();
        this.hashes = this.merkleTree;
    }

    this._hash = null;

    // Verify partial merkle tree and fill `ts` array
    this._verifyMerkle();
}
module.exports = Block;

Block.prototype.hash = function hash(enc) {
    // Hash it
    if (!this._hash) this._hash = utils.toHex(utils.dsha256(this.abbr()));
    return enc === 'hex' ? this._hash : utils.toArray(this._hash, 'hex');
};

Block.prototype.abbr = function abbr() {
    var res = new Array(80);
    utils.writeU32(res, this.version, 0);
    utils.copy(utils.toArray(this.prevBlock, 'hex'), res, 4);
    utils.copy(utils.toArray(this.merkleRoot, 'hex'), res, 36);
    utils.writeU32(res, this.ts, 68);
    utils.writeU32(res, this.bits, 72);
    utils.writeU32(res, this.nonce, 76);

    return res;
};

Block.prototype.verify = function verify() {
    return !this.invalid && utils.testTarget(this.bits, this.hash());
};

Block.prototype.render = function render() {
    return protocol.framer.block(this, this.subtype);
};

Block.prototype.hasTX = function hasTX(hash) {
    return this.tx.indexOf(hash) !== -1;
};

Block.prototype._verifyMerkle = function verifyMerkle() {
    var height = 0;

    if (this.subtype === 'block') return;

    // Count leafs
    for (var i = this.totalTX; i > 0; i >>= 1)
    height++;
    if (this.totalTX > (1 << (height - 1))) height++;

    var tx = [];
    var i = 0;
    var j = 0;
    var hashes = this.hashes;
    var flags = this.flags;

    var root = visit(1);
    if (!root || root !== this.merkleRoot) {
        this.invalid = true;
        return;
    }
    this.tx = tx;

    function visit(depth) {
        if (i === flags.length * 8 || j === hashes.length) return null;

        var flag = (flags[i >> 3] >>> (i & 7)) & 1;
        i++;

        if (flag === 0 || depth === height) {
            if (depth === height) tx.push(hashes[j]);
            return hashes[j++];
        }

        // Go deeper
        var left = visit(depth + 1);
        if (!left) return null;
        var right = visit(depth + 1);
        if (right === left) return null;
        if (!right) right = left;
        return utils.toHex(utils.dsha256(left + right, 'hex'));
    }
};

Block.prototype._buildMerkle = function buildMerkle() {
    var merkleTree = [];
    for (var i = 0; i < this.txs.length; i++) {
        merkleTree.push(this.txs[i].hash('hex'));
    }
    var j = 0;
    for (var size = this.txs.length; size > 1; size = ((size + 1) / 2) | 0) {
        for (var i = 0; i < size; i += 2) {
            var i2 = Math.min(i + 1, size - 1);
            var hash = utils.dsha256(merkleTree[j + i] + merkleTree[j + i2], 'hex');
            merkleTree.push(utils.toHex(hash));
        }
        j += size;
    }
    return merkleTree;
};

// This mimics the behavior of CheckBlockHeader()
// and CheckBlock() in bitcoin/src/main.cpp.
Block.prototype._checkBlock = function checkBlock() {
    // Check proof of work matches claimed amount
    if (!utils.testTarget(this.bits, this.hash())) return false;

    // Check timestamp
    if (this.ts > (Date.now() / 1000) + 2 * 60 * 60) return false;

    // Size of all txs cant be bigger than MAX_BLOCK_SIZE
    if (this.txs.length > this.parser.constants.block.maxSize) return false;

    // First TX must be a coinbase
    if (!this.txs.length || this.txs[0].inputs.length !== 1 || +this.txs[0].inputs[0].out.hash !== 0) return false;

    // The rest of the txs must not be coinbases
    for (var i = 1; i < this.txs.length; i++) {
        if (this.txs[i].inputs.length === 1 && +this.txs[i].inputs[0].out.hash === 0) return false;
    }

    // Build MerkleTree
    this.merkleTree = this._buildMerkle();

    // Check for duplicate tx ids
    var unique = {};
    for (var i = 0; i < this.txs.length; i++) {
        var hash = this.txs[i].hash('hex');
        if (unique[hash]) return false;
        unique[hash] = true;
    }

    // Check merkle root
    return this.merkleTree[this.merkleTree.length - 1] === this.merkleRoot;
};

Block.prototype.toJSON = function toJSON() {
    return {
        v: '1',
        type: 'block',
        subtype: this.subtype,
        hash: this.hash('hex'),
        prevBlock: this.prevBlock,
        ts: this.ts,
        block: utils.toHex(protocol.framer.block(this, this.subtype))
    };
};

Block.fromJSON = function fromJSON(network, json) {
    utils.assert.equal(json.v, 1);
    utils.assert.equal(json.type, 'block');

    var raw = utils.toArray(json.block, 'hex');

    var parser = new protocol.parser(network);

    var data = json.subtype === 'merkleblock' ? parser.parseMerkleBlock(raw) : parser.parseBlock(raw);

    var block = new Block(network, data, json.subtype);

    block._hash = json.hash;

    return block;
};
