async function run() {
  try {
    // 1. Create a new bin
    console.log('Creating bin...');
    const createResp = await fetch('https://api.npoint.io', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial: true })
    });
    console.log('Create status:', createResp.status);
    const createData = await createResp.json();
    console.log('Create response:', createData);

    const binId = createData.binId;
    if (!binId) {
      console.error('No binId returned!');
      return;
    }

    // 2. Read the bin
    console.log(`Reading bin ${binId}...`);
    const readResp = await fetch(`https://api.npoint.io/${binId}`);
    console.log('Read status:', readResp.status);
    const readData = await readResp.json();
    console.log('Read response:', readData);

    // 3. Update the bin
    console.log(`Updating bin ${binId}...`);
    const updateResp = await fetch(`https://api.npoint.io/${binId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updated: true, hello: 'world' })
    });
    console.log('Update status:', updateResp.status);
    const updateData = await updateResp.json();
    console.log('Update response:', updateData);

    // 4. Read again
    console.log(`Reading bin ${binId} again...`);
    const readResp2 = await fetch(`https://api.npoint.io/${binId}`);
    console.log('Read 2 status:', readResp2.status);
    const readData2 = await readResp2.json();
    console.log('Read 2 response:', readData2);

  } catch (e) {
    console.error('Error:', e);
  }
}

run();
