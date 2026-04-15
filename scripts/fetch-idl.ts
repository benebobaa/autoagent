import { Connection, PublicKey } from '@solana/web3.js';

async function main() {
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const programId = new PublicKey('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');

  console.log('Searching for marginfi IDL...');

  const derivations = [
    [Buffer.from('anchor:idl')],
    [Buffer.from('idl')],
  ];

  for (const seeds of derivations) {
    const pda = PublicKey.findProgramAddressSync(seeds, programId)[0];
    console.log('Checking PDA:', pda.toBase58());
    const info = await connection.getAccountInfo(pda);
    if (info) {
      console.log('  Found! Size:', info.data.length);
    }
  }

  console.log('\nLooking for IDL account using getProgramAccounts...');

  const accounts = await connection.getProgramAccounts(programId, {
    filters: [{ dataSize: 1000000 }],
  });

  console.log('Found', accounts.length, 'accounts with dataSize > 1MB');
  accounts.slice(0, 5).forEach((acc) => {
    console.log(' -', acc.pubkey.toBase58(), 'size:', acc.account.data.length);
  });

  const midAccounts = await connection.getProgramAccounts(programId, {
    filters: [{ dataSize: 100000 }],
  });

  console.log('Found', midAccounts.length, 'accounts with dataSize > 100KB');
  midAccounts.slice(0, 5).forEach((acc) => {
    console.log(' -', acc.pubkey.toBase58(), 'size:', acc.account.data.length);
  });
}

main().catch(console.error);
