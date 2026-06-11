const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('usage: baseline-cli greet <name>'); process.exit(0); }
if (args[0] === 'greet' && args[1]) { console.log('hello ' + args[1]); process.exit(0); }
console.error('invalid command'); process.exit(2);
