import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import '@openzeppelin/hardhat-upgrades';
import 'hardhat-gas-reporter';
import 'solidity-coverage';
import { getAdminAddress, getImplementationAddress } from '@openzeppelin/upgrades-core';

import { Contract, Signer, Wallet, BigNumber } from 'ethers';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { HardhatUserConfig, task } from 'hardhat/config';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { parseUnits } from 'ethers/lib/utils';

const SDK_PATH = './sdk';

// Loads env variables from .env file
import * as dotenv from 'dotenv';
dotenv.config();

async function deployContract(
  name: string,
  getContractFactory: Function,
  signer: Signer,
  args: Array<any> = [],
): Promise<Contract> {
  const factory = await getContractFactory(name, signer);
  const contract = await factory.deploy(...args);
  console.log('Deploying', name);
  console.log('  to', contract.address);
  console.log('  in', contract.deployTransaction.hash);
  return contract.deployed();
}

async function deployMockAmpl(
  admin: SignerWithAddress,
  getContractFactory: Function,
  deployProxy: Function,
): Promise<Contract> {
  const factory = await getContractFactory('MockAmpl');
  const ampl = await deployProxy(factory, [admin.address], {
    initializer: 'initialize(address)',
  });
  await ampl.connect(admin).setMonetaryPolicy(admin.address);
  const amplInitialSupply = (await ampl.balanceOf(admin.address)) as BigNumber;
  console.log('Deploying MockAmpl');
  console.log('  to', ampl.address);
  console.log('  in', ampl.deployTransaction.hash);
  console.log('Initial Ample Supply: ', amplInitialSupply.toString());
  return ampl;
}

async function createInstance(
  instanceName: string,
  factory: Contract,
  getContractAt: Function,
  signer: Signer,
  args: string = '0x',
) {
  // get contract class
  const instance = await getContractAt(instanceName, await factory.connect(signer).callStatic['create(bytes)'](args));
  // deploy vault
  const tx = await factory.connect(signer)['create(bytes)'](args);
  // return contract class
  console.log('Deploying', instanceName);
  console.log('  to', instance.address);
  console.log('  in', tx.hash);
  return instance;
}

task('deploy', 'deploy full set of factory contracts')
  .addFlag('mock')
  .setAction(async ({ mock }, { ethers, run, network, upgrades }) => {
    await run('compile');

    const signer = (await ethers.getSigners())[0];

    console.log('Signer', signer.address);

    const timestamp = (await signer.provider?.getBlock('latest'))?.timestamp;

    const PowerSwitchFactory = await deployContract('PowerSwitchFactory', ethers.getContractFactory, signer);
    const RewardPoolFactory = await deployContract('RewardPoolFactory', ethers.getContractFactory, signer);
    const UniversalVault = await deployContract('UniversalVault', ethers.getContractFactory, signer);
    const VaultFactory = await deployContract('VaultFactory', ethers.getContractFactory, signer, [
      UniversalVault.address,
    ]);
    const GeyserRegistry = await deployContract('GeyserRegistry', ethers.getContractFactory, signer);
    const RouterV1 = await deployContract('RouterV1', ethers.getContractFactory, signer);

    if (mock) {
      const totalSupply = parseUnits('10');
      await deployContract('MockERC20', ethers.getContractFactory, signer, [signer.address, totalSupply]);
      await deployContract('MockBAL', ethers.getContractFactory, signer, [signer.address, totalSupply]);
      await deployMockAmpl(signer, ethers.getContractFactory, upgrades.deployProxy);
    }

    console.log('Locking template');

    await UniversalVault.initializeLock();

    const path = `${SDK_PATH}/deployments/${network.name}/`;
    const file = `factories-${timestamp}.json`;
    const latest = `factories-latest.json`;

    console.log('Saving config to', path + file);

    const blob = JSON.stringify({
      PowerSwitchFactory: {
        address: PowerSwitchFactory.address,
        abi: PowerSwitchFactory.interface.format(),
      },
      RewardPoolFactory: {
        address: RewardPoolFactory.address,
        abi: RewardPoolFactory.interface.format(),
      },
      VaultTemplate: {
        address: UniversalVault.address,
        abi: UniversalVault.interface.format(),
      },
      VaultFactory: {
        address: VaultFactory.address,
        abi: VaultFactory.interface.format(),
      },
      GeyserRegistry: {
        address: GeyserRegistry.address,
        abi: GeyserRegistry.interface.format(),
      },
      GeyserTemplate: {
        abi: (await ethers.getContractAt('Geyser', ethers.constants.AddressZero)).interface.format(),
      },
      RouterV1: {
        address: RouterV1.address,
        abi: RouterV1.interface.format(),
      },
    });

    mkdirSync(path, { recursive: true });
    writeFileSync(path + file, blob);
    writeFileSync(path + latest, blob);
  });

task('verify-factories', 'verfires the deployed factories')
  .addOptionalParam('factoryVersion', 'the factory version', 'latest')
  .setAction(async ({ factoryVersion }, { ethers, run, network }) => {
    const { PowerSwitchFactory, RewardPoolFactory, VaultFactory, GeyserRegistry, VaultTemplate } = JSON.parse(
      readFileSync(`${SDK_PATH}/deployments/${network.name}/factories-${factoryVersion}.json`).toString(),
    );

    console.log('Verifying source on etherscan');
    try {
      await run('verify:verify', {
        address: PowerSwitchFactory.address,
      });
      console.log('Done verifying PowerSwitchFactory');
    } catch (e) {
      console.error('Failed to verify PowerSwitchFactory', e);
    }
    try {
      await run('verify:verify', {
        address: RewardPoolFactory.address,
      });
      console.log('Done verifying RewardPoolFactory');
    } catch (e) {}
    try {
      await run('verify:verify', {
        address: VaultTemplate.address,
      });
      console.log('Done verifying VaultTemplate');
    } catch (e) {}
    try {
      await run('verify:verify', {
        address: VaultFactory.address,
        constructorArguments: [VaultTemplate.address],
      });
      console.log('Done verifying VaultFactory');
    } catch (e) {}
    try {
      await run('verify:verify', {
        address: GeyserRegistry.address,
      });
      console.log('Done verifying GeyserRegistry');
    } catch (e) {}
  });

task('create-vault', 'deploy an instance of UniversalVault')
  .addOptionalPositionalParam('factoryVersion', 'the factory version', 'latest')
  .setAction(async ({ factoryVersion }, { ethers, run, network }) => {
    await run('compile');

    const signer = (await ethers.getSigners())[0];

    console.log('Signer', signer.address);

    const { VaultFactory } = JSON.parse(
      readFileSync(`${SDK_PATH}/deployments/${network.name}/factories-${factoryVersion}.json`).toString(),
    );

    const vaultFactory = await ethers.getContractAt('VaultFactory', VaultFactory.address, signer);

    await createInstance('UniversalVault', vaultFactory, ethers.getContractAt, signer);
  });

task('create-geyser', 'deploy an instance of Geyser')
  .addParam('stakingToken', 'the staking token')
  .addParam('rewardToken', 'the reward token')
  .addParam('floor', 'the floor of reward scaling')
  .addParam('ceiling', 'the ceiling of reward scaling')
  .addParam('time', 'the time of reward scaling in seconds')
  .addOptionalParam('finalOwner', 'the address of the final owner', '0x')
  .addOptionalParam('factoryVersion', 'the factory version', 'latest')
  .setAction(
    async (
      { factoryVersion, stakingToken, rewardToken, floor, ceiling, time, finalOwner },
      { ethers, run, upgrades, network },
    ) => {
      await run('compile');

      const signer = (await ethers.getSigners())[0];

      console.log('Signer', signer.address);
      const { PowerSwitchFactory, RewardPoolFactory, VaultFactory, GeyserRegistry } = JSON.parse(
        readFileSync(`${SDK_PATH}/deployments/${network.name}/factories-${factoryVersion}.json`).toString(),
      );
      console.log({ PowerSwitchFactory, RewardPoolFactory, VaultFactory, GeyserRegistry });

      const factory = await ethers.getContractFactory('Geyser', signer);
      const geyser = await upgrades.deployProxy(factory, undefined, {
        initializer: false,
      });
      await geyser.deployTransaction.wait(1);
      const implementation = await getImplementationAddress(ethers.provider, geyser.address);
      const proxyAdminAddress = await getAdminAddress(ethers.provider, geyser.address);
      console.log('Deploying Geyser');
      console.log('  to proxy', geyser.address);
      console.log('  to implementation', implementation);
      console.log('  with upgreadability admin', proxyAdminAddress);
      console.log('  in', geyser.deployTransaction.hash);
      console.log('  staking token', stakingToken);
      console.log('  reward token', rewardToken);
      console.log('  reward floor', floor);
      console.log('  reward ceiling', ceiling);

      // CRITICAL: The ordering of the following transaction can't change for the subgraph to be indexed

      // Note: geyser registry is owned by the ecofund multisig
      // this script will fail here
      // the following need to be executed manually
      console.log('Register Geyser Instance');
      const geyserRegistry = await ethers.getContractAt('GeyserRegistry', GeyserRegistry.address, signer);
      await (await geyserRegistry.register(geyser.address)).wait(1);

      console.log('initialize geyser');
      await (
        await geyser.initialize(
          signer.address,
          RewardPoolFactory.address,
          PowerSwitchFactory.address,
          stakingToken,
          rewardToken,
          [floor, ceiling, time],
        )
      ).wait(1);

      console.log('Register Vault Factory');
      await (await geyser.registerVaultFactory(VaultFactory.address)).wait(1);

      if (finalOwner !== '0x') {
        console.log('Transfer ownership');
        const powerSwitch = await ethers.getContractAt(
          '@openzeppelin/contracts/access/Ownable.sol:Ownable',
          await geyser.getPowerSwitch(),
        );
        const proxyAdmin = await ethers.getContractAt(
          '@openzeppelin/contracts/access/Ownable.sol:Ownable',
          proxyAdminAddress,
        );
        await (await powerSwitch.transferOwnership(finalOwner)).wait(1);
        await (await geyser.transferOwnership(finalOwner)).wait(1);
        await (await proxyAdmin.transferOwnership(finalOwner)).wait(1);
      }
    },
  );

task('fund-geyser', 'fund an instance of Geyser')
  .addParam('geyser', 'address of geyser')
  .addParam('amount', 'amount as raw integer')
  .addParam('duration', 'time in seconds the program lasts')
  .addOptionalParam('factoryVersion', 'the factory version', 'latest')
  .setAction(async ({ geyser, amount, duration }, { ethers }) => {
    const signer = (await ethers.getSigners())[0];
    const geyserContract = await ethers.getContractAt('Geyser', geyser, signer);
    const data = await geyserContract.getGeyserData();
    const { rewardToken: rewardTokenAddress } = data;
    const rewardToken = await ethers.getContractAt('MockAmpl', rewardTokenAddress, signer);
    const amt = parseUnits(amount, 0);
    await rewardToken.approve(geyser, amt);
    await geyserContract.connect(signer).fundGeyser(amt, duration);
  });

// currently need to manually run verify command
// ie) the implementation address of the deployed proxy through create-geyser
// can automate after this issue is closed: https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/290
task('verify-geyser', 'verify and lock the Geyser template')
  .addPositionalParam('geysertemplate', 'the geyser template address')
  .setAction(async ({ geysertemplate }, { ethers, run, upgrades, network }) => {
    await run('compile');

    const signer = (await ethers.getSigners())[0];

    console.log('Signer', signer.address);

    const contract = await ethers.getContractAt('Geyser', geysertemplate, signer);

    console.log('Locking template');

    await contract.initializeLock();

    console.log('Verifying source on etherscan');

    await run('verify:verify', {
      address: contract.address,
    });

    // TODO: verify reward pool
  });

task('register-vault-factory', 'register a vault factory instance with a Geyser')
  .addParam('geyser', 'address of geyser')
  .addParam('vaultFactory', 'address of vault factory')
  .setAction(async ({ geyser, vaultFactory }, { ethers }) => {
    const signer = (await ethers.getSigners())[0];
    const geyserContract = await ethers.getContractAt('Geyser', geyser, signer);
    const res = await geyserContract.connect(signer).registerVaultFactory(vaultFactory);
    console.log(`Transaction hash: ${res.hash}`);
  });

task('lookup-proxy-admin', 'gets the proxy admin of the given contract')
  .addPositionalParam('address', 'the proxy contract address')
  .setAction(async ({ address }, { ethers, run, upgrades, network }) => {
    console.log('Proxy Admin:', await getAdminAddress(ethers.provider, address));
  });

task('transfer-ownership', 'transfers a contract that implements Ownable to a new owner')
  .addParam('contract', 'address of Ownable contract')
  .addParam('owner', 'address of new owner')
  .setAction(async ({ contract, owner }, { ethers }) => {
    const ownable = await ethers.getContractAt('@openzeppelin/contracts/access/Ownable.sol:Ownable', contract);
    const res = await ownable.transferOwnership(owner);
    console.log(`Transaction hash: ${res.hash}`);
  });

const getEtherscanAPIKey = () => {
  switch (process.env.HARDHAT_NETWORK) {
    case 'mainnet' || 'kovan' || 'goerli' || 'sepolia': {
      console.log('Using etherscan api key');
      return process.env.ETHERSCAN_API_KEY;
    }
    case 'avalanche' || 'avalanche_fiji': {
      console.log('Using snowtrace API key');
      return process.env.SNOWTRACE_API_KEY;
    }
    case 'arbitrum': {
      console.log('Using arbiscan API key');
      return process.env.ARBISCAN_API_KEY;
    }
    case 'optimisticEthereum': {
      console.log('Using optimistic-etherscan API key');
      return process.env.OPTIMISTIC_ETHERSCAN_API_KEY;
    }
    case 'base-mainnet': {
      console.log('Using base API key');
      return process.env.BASE_API_KEY;
    }
    case 'base-goerli' || 'base-mainnet': {
      console.log('Using base API key');
      return process.env.BASE_API_KEY;
    }
    case 'sei-devnet': {
      console.log('Using sei-trace API key');
      return process.env.SEITRACE_API_KEY;
    }
    case 'polygon': {
      console.log('Using polygon-scan API key');
      return process.env.POLYGONSCAN_API_KEY;
    }
    default:
      return '';
  }
};

// When using a local network, MetaMask assumes a chainId of 1337, even though the default chainId of HardHat is 31337
// https://github.com/MetaMask/metamask-extension/issues/10290
export default {
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      chainId: 1337,
    },
    ganache: {
      url: 'http://127.0.0.1:8545',
      chainId: 1337,
    },
    goerli: {
      url: `https://goerli.infura.io/v3/${process.env.INFURA_SECRET}`,
      accounts: process.env.DEV_PKEY
        ? [process.env.DEV_PKEY]
        : {
            mnemonic: process.env.DEV_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
      allowUnlimitedContractSize: true,
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_SECRET}`,
      accounts: process.env.PROD_PKEY
        ? [process.env.PROD_PKEY]
        : {
            mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
    },
    'base-mainnet': {
      url: 'https://mainnet.base.org',
      accounts: process.env.PROD_PKEY
        ? [process.env.PROD_PKEY]
        : {
            mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      urls: {
        apiURL: 'https://api.basescan.org/api',
        browserURL: 'https://basescan.org',
      },
      gasMultiplier: 1.03,
    },
    'base-goerli': {
      url: 'https://goerli.base.org',
      accounts: process.env.DEV_PKEY
        ? [process.env.DEV_PKEY]
        : {
            mnemonic: process.env.DEV_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      urls: {
        apiURL: 'https://api.basescan.org/api',
        browserURL: 'https://basescan.org',
      },
      gasMultiplier: 1.03,
    },
    avalanche: {
      url: 'https://api.avax.network/ext/bc/C/rpc',
      accounts: process.env.PROD_PKEY
        ? [process.env.PROD_PKEY]
        : {
            mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
      chainId: 43114,
    },
    arbitrum: {
      url: 'https://arb1.arbitrum.io/rpc',
      accounts: process.env.PROD_PKEY
        ? [process.env.PROD_PKEY]
        : {
            mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
      chainId: 42161,
    },
    optimisticEthereum: {
      url: 'https://mainnet.optimism.io',
      accounts: process.env.PROD_PKEY
        ? [process.env.PROD_PKEY]
        : {
            mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
      chainId: 10,
    },
    'sei-devnet': {
      url: 'https://evm-rpc.arctic-1.seinetwork.io',
      accounts: process.env.DEV_PKEY
        ? [process.env.DEV_PKEY]
        : {
            mnemonic: process.env.DEV_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      chainId: 713715,
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_SECRET}`,
      accounts: process.env.DEV_PKEY
        ? [process.env.DEV_PKEY]
        : {
            mnemonic: process.env.DEV_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
      allowUnlimitedContractSize: true,
    },
    polygon: {
      url: `https://polygon-mainnet.infura.io/v3/${process.env.INFURA_SECRET}`,
      accounts: process.env.PROD_PKEY
        ? [process.env.PROD_PKEY]
        : {
            mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
          },
      gasMultiplier: 1.03,
      allowUnlimitedContractSize: true,
    },
  },
  solidity: {
    compilers: [
      {
        version: '0.4.24',
      },
      {
        version: '0.7.6',
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
        },
      },
    ],
  },
  etherscan: {
    apiKey: getEtherscanAPIKey(),
    customChains: [
      {
        network: 'base-mainnet',
        chainId: 8453,
        urls: {
          apiURL: 'https://api.basescan.org/api',
          browserURL: 'https://basescan.org',
        },
      },
      {
        network: 'base-goerli',
        chainId: 84531,
        urls: {
          apiURL: 'https://api-goerli.basescan.org/api',
          browserURL: 'https://goerli.basescan.org',
        },
      },
    ],
  },
  mocha: {
    timeout: 100000,
  },
  gasReporter: {
    currency: 'USD',
    enabled: process.env.REPORT_GAS ? true : false,
    excludeContracts: ['Mock/'],
  },
} as HardhatUserConfig;
