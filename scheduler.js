// scheduler.js
const cron = require('node-cron');
const Raffle = require('./models/Raffle');
const { sendKaspa, sendKRC20 } = require('./wasm_rpc');

async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Find raffles that are live but whose timeframe is passed.
    const expiredRaffles = await Raffle.find({ status: "live", timeFrame: { $lte: now } });
    console.log(`Found ${expiredRaffles.length} expired raffles to complete.`);

    for (const raffle of expiredRaffles) {
      // Determine winners via your weighted random selection logic.
      if (raffle.entries && raffle.entries.length > 0) {
        const walletTotals = {};
        raffle.entries.forEach(entry => {
          walletTotals[entry.walletAddress] = (walletTotals[entry.walletAddress] || 0) + entry.creditsAdded;
        });
        if (raffle.winnersCount === 1) {
          const totalCredits = Object.values(walletTotals).reduce((sum, val) => sum + val, 0);
          let random = Math.random() * totalCredits;
          let chosen = null;
          for (const [wallet, credits] of Object.entries(walletTotals)) {
            random -= credits;
            if (random <= 0) {
              chosen = wallet;
              break;
            }
          }
          raffle.winner = chosen;
          raffle.winnersList = [];
        } else {
          const winners = [];
          const availableWallets = { ...walletTotals };
          const maxWinners = Math.min(raffle.winnersCount, Object.keys(availableWallets).length);
          for (let i = 0; i < maxWinners; i++) {
            const totalCredits = Object.values(availableWallets).reduce((sum, val) => sum + val, 0);
            let random = Math.random() * totalCredits;
            let chosenWallet = null;
            for (const [wallet, credits] of Object.entries(availableWallets)) {
              random -= credits;
              if (random <= 0) {
                chosenWallet = wallet;
                break;
              }
            }
            if (chosenWallet) {
              winners.push(chosenWallet);
              delete availableWallets[chosenWallet];
            }
          }
          raffle.winner = winners.length === 1 ? winners[0] : null;
          raffle.winnersList = winners;
        }
      } else {
        raffle.winner = "No Entries";
        raffle.winnersList = [];
      }
      raffle.status = "completed";
      raffle.completedAt = now;
      await raffle.save();

      // Only send prizes if winners exist.
      let winnersArray = [];
      if (raffle.winnersList && raffle.winnersList.length > 0) {
        winnersArray = raffle.winnersList;
      } else if (raffle.winner && raffle.winner !== "No Entries") {
        winnersArray = [raffle.winner];
      }

      // Calculate per-winner prize (splitting evenly).
      if (winnersArray.length > 0) {
        const totalPrize = raffle.prizeAmount;
        const perWinnerPrize = totalPrize / winnersArray.length;

        // For each winner, send the prize.
        for (const winnerAddress of winnersArray) {
          try {
            let txid;
            if (raffle.prizeType === "KAS") {
              txid = await sendKaspa(winnerAddress, perWinnerPrize);
            } else if (raffle.prizeType === "KRC20") {
              // For KRC20, we use the token ticker stored in raffle.tokenTicker.
              txid = await sendKRC20(winnerAddress, perWinnerPrize, raffle.tokenTicker);
            }
            console.log(`Sent prize to ${winnerAddress}. Transaction ID: ${txid}`);
            // Optionally, record the prize transaction details on the raffle.
            raffle.processedTransactions.push({
              txid,
              coinType: raffle.prizeType,
              amount: perWinnerPrize,
              timestamp: new Date()
            });
          } catch (err) {
            console.error(`Error sending prize to ${winnerAddress}: ${err.message}`);
          }
        }
        // Mark that the prize has been confirmed.
        raffle.prizeConfirmed = true;
        // You could also store an array of prize txids if needed.
        await raffle.save();
      }
      if (winnersArray.length > 0) {
        console.log(`Raffle ${raffle.raffleId} completed. Winners: ${winnersArray.join(', ')}`);
      } else {
        console.log(`Raffle ${raffle.raffleId} completed. No valid entries for prize distribution.`);
      }
    }
  } catch (err) {
    console.error('Error in completing raffles:', err);
  }
}

// Schedule the job to run every minute.
cron.schedule('* * * * *', async () => {
  console.log('Running raffle completion scheduler...');
  await completeExpiredRaffles();
});

console.log('Raffle completion scheduler started.');
