import { ethers, upgrades, waffle } from 'hardhat'
import { Contract, Signer, BigNumber, BigNumberish, Event } from 'ethers'
import { TransactionResponse } from '@ethersproject/providers'
import { expect } from 'chai'
import { Result } from 'ethers/lib/utils'
import { imul, increaseTime } from '../utils/utils'

let uFragmentsPolicy: Contract, mockUFragments: Contract
let prevEpoch: BigNumber, prevTime: BigNumber
let deployer: Signer, user: Signer, orchestrator: Signer

const MAX_RATE = ethers.utils.parseUnits('1', 6)
const MAX_SUPPLY = ethers.BigNumber.from(2).pow(255).sub(1).div(MAX_RATE)
const INITIAL_RATE = ethers.utils.parseUnits('0.0019', 6)

async function mockedUpgradablePolicy() {
  // get signers
  const [deployer, user, orchestrator] = await ethers.getSigners()
  // deploy mocks
  const mockUFragments = await (
    await ethers.getContractFactory('MockUFragments')
  )
    .connect(deployer)
    .deploy()
  // deploy upgradable contract
  const uFragmentsPolicy = await upgrades.deployProxy(
    (await ethers.getContractFactory('UFragmentsPolicy')).connect(deployer),
    [await deployer.getAddress(), mockUFragments.address],
    {
      initializer: 'initialize(address,address)',
    },
  )
  // setup orchestrator
  await uFragmentsPolicy
    .connect(deployer)
    .setOrchestrator(await orchestrator.getAddress())
  // return entities
  return {
    deployer,
    user,
    orchestrator,
    mockUFragments,
    uFragmentsPolicy,
  }
}

async function mockedUpgradablePolicyWithOpenRebaseWindow() {
  const {
    deployer,
    user,
    orchestrator,
    mockUFragments,
    uFragmentsPolicy,
  } = await mockedUpgradablePolicy()
  await uFragmentsPolicy.connect(deployer).setRebaseTimingParameters(60, 0, 60)
  return {
    deployer,
    user,
    orchestrator,
    mockUFragments,
    uFragmentsPolicy,
  }
}

async function mockExternalData(uFragSupply: BigNumberish) {
  await mockUFragments.connect(deployer).storeSupply(uFragSupply)
}

async function parseRebaseLog(response: Promise<TransactionResponse>) {
  const receipt = (await (await response).wait()) as any
  const logs = receipt.events.filter(
    (event: Event) => event.event === 'LogRebase',
  )
  return logs[0].args
}

describe('UFragmentsPolicy', function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  it('should reject any ether sent to it', async function () {
    await expect(
      user.sendTransaction({ to: uFragmentsPolicy.address, value: 1 }),
    ).to.be.reverted
  })
})

describe('UFragmentsPolicy:initialize', async function () {
  describe('initial values set correctly', function () {
    before('setup UFragmentsPolicy contract', async () => {
      ;({
        deployer,
        user,
        orchestrator,
        mockUFragments,
        uFragmentsPolicy,
      } = await waffle.loadFixture(mockedUpgradablePolicy))
    })

    it('inflationRate', async function () {
      expect(await uFragmentsPolicy.inflationRate()).to.eq(0.0019 * 10 ** 6)
    })
    it('minRebaseTimeIntervalSec', async function () {
      expect(await uFragmentsPolicy.minRebaseTimeIntervalSec()).to.eq(
        24 * 60 * 60,
      )
    })
    it('epoch', async function () {
      expect(await uFragmentsPolicy.epoch()).to.eq(0)
    })
    it('globalUpEpochAndUPSupply', async function () {
      const r = await uFragmentsPolicy.globalUpEpochAndUPSupply()
      expect(r[0]).to.eq(0)
      expect(r[1]).to.eq(0)
    })
    it('rebaseWindowOffsetSec', async function () {
      expect(await uFragmentsPolicy.rebaseWindowOffsetSec()).to.eq(72000)
    })
    it('rebaseWindowLengthSec', async function () {
      expect(await uFragmentsPolicy.rebaseWindowLengthSec()).to.eq(900)
    })
    it('should set owner', async function () {
      expect(await uFragmentsPolicy.owner()).to.eq(await deployer.getAddress())
    })
    it('should set reference to uFragments', async function () {
      expect(await uFragmentsPolicy.uFrags()).to.eq(mockUFragments.address)
    })
  })
})

describe('UFragmentsPolicy:setOrchestrator', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  it('should set orchestrator', async function () {
    await uFragmentsPolicy
      .connect(deployer)
      .setOrchestrator(await user.getAddress())
    expect(await uFragmentsPolicy.orchestrator()).to.eq(await user.getAddress())
  })
})

describe('UFragments:setOrchestrator:accessControl', function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  it('should be callable by owner', async function () {
    await expect(
      uFragmentsPolicy
        .connect(deployer)
        .setOrchestrator(await deployer.getAddress()),
    ).to.not.be.reverted
  })

  it('should NOT be callable by non-owner', async function () {
    await expect(
      uFragmentsPolicy
        .connect(user)
        .setOrchestrator(await deployer.getAddress()),
    ).to.be.reverted
  })
})

describe('UFragmentsPolicy:setInflationRate', async function () {
  before('setup UFragmentsPolicy contract', async function () {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  describe('when inflationRate=0', function () {
    it('should succeed', async function () {
      await expect(uFragmentsPolicy.connect(deployer).setInflationRate(0)).to
        .not.be.reverted
    })
  })

  describe('when inflationRate=1900', function () {
    it('should succeed', async function () {
      await expect(uFragmentsPolicy.connect(deployer).setInflationRate(2900)).to
        .not.be.reverted
    })
  })

  describe('when inflationRate=-1', function () {
    it('should fail', async function () {
      await expect(uFragmentsPolicy.connect(deployer).setInflationRate(-1)).to
        .be.reverted
    })
  })
})

describe('UFragmentsPolicy:setInflationRate:accessControl', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  it('should be callable by owner', async function () {
    await expect(uFragmentsPolicy.connect(deployer).setInflationRate(2900)).to
      .not.be.reverted
  })

  it('should NOT be callable by non-owner', async function () {
    await expect(uFragmentsPolicy.connect(user).setInflationRate(2900)).to.be
      .reverted
  })
})

describe('UFragmentsPolicy:setRebaseTimingParameters', async function () {
  before('setup UFragmentsPolicy contract', async function () {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  describe('when interval=0', function () {
    it('should fail', async function () {
      await expect(
        uFragmentsPolicy.connect(deployer).setRebaseTimingParameters(0, 0, 0),
      ).to.be.reverted
    })
  })

  describe('when offset > interval', function () {
    it('should fail', async function () {
      await expect(
        uFragmentsPolicy
          .connect(deployer)
          .setRebaseTimingParameters(300, 3600, 300),
      ).to.be.reverted
    })
  })

  describe('when params are valid', function () {
    it('should setRebaseTimingParameters', async function () {
      await uFragmentsPolicy
        .connect(deployer)
        .setRebaseTimingParameters(600, 60, 300)
      expect(await uFragmentsPolicy.minRebaseTimeIntervalSec()).to.eq(600)
      expect(await uFragmentsPolicy.rebaseWindowOffsetSec()).to.eq(60)
      expect(await uFragmentsPolicy.rebaseWindowLengthSec()).to.eq(300)
    })
  })
})

describe('UFragments:setRebaseTimingParameters:accessControl', function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
  })

  it('should be callable by owner', async function () {
    await expect(
      uFragmentsPolicy
        .connect(deployer)
        .setRebaseTimingParameters(600, 60, 300),
    ).to.not.be.reverted
  })

  it('should NOT be callable by non-owner', async function () {
    await expect(
      uFragmentsPolicy.connect(user).setRebaseTimingParameters(600, 60, 300),
    ).to.be.reverted
  })
})

describe('UFragmentsPolicy:Rebase:accessControl', async function () {
  beforeEach('setup UFragmentsPolicy contract', async function () {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
    // await setupContractsWithOpenRebaseWindow()
    await mockExternalData(1000)
    await increaseTime(60)
  })

  describe('when rebase called by orchestrator', function () {
    it('should succeed', async function () {
      await expect(uFragmentsPolicy.connect(orchestrator).rebase()).to.not.be
        .reverted
    })
  })

  describe('when rebase called by non-orchestrator', function () {
    it('should fail', async function () {
      await expect(uFragmentsPolicy.connect(user).rebase()).to.be.reverted
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
  })

  describe('when minRebaseTimeIntervalSec has NOT passed since the previous rebase', function () {
    before(async function () {
      await mockExternalData(1010)
      await increaseTime(60)
      await uFragmentsPolicy.connect(orchestrator).rebase()
    })

    it('should fail', async function () {
      await expect(uFragmentsPolicy.connect(orchestrator).rebase()).to.be
        .reverted
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
  })

  describe('when rate is more than MAX_RATE', function () {
    it('should fail', async function () {
      // Any exchangeRate >= (MAX_RATE=100x) would result in the same supply increase
      await uFragmentsPolicy.connect(deployer).setInflationRate(MAX_RATE)
      await increaseTime(60)

      const supplyChange = (
        await parseRebaseLog(uFragmentsPolicy.connect(orchestrator).rebase())
      ).requestedSupplyAdjustment

      await increaseTime(60)

      await expect(
        uFragmentsPolicy
          .connect(deployer)
          .setInflationRate(MAX_RATE.add(ethers.utils.parseUnits('1', 5))),
      ).to.be.reverted

      await increaseTime(60)

      await expect(
        uFragmentsPolicy.connect(deployer).setInflationRate(MAX_RATE.mul(2)),
      ).to.be.reverted
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
  })

  describe('when uFragments grows beyond MAX_SUPPLY', function () {
    before(async function () {
      await mockExternalData(MAX_SUPPLY.sub(1))
      await increaseTime(60)
    })

    it('should apply SupplyAdjustment {MAX_SUPPLY - totalSupply}', async function () {
      // Supply is MAX_SUPPLY-1, exchangeRate is 2x; resulting in a new supply more than MAX_SUPPLY
      // However, supply is ONLY increased by 1 to MAX_SUPPLY
      expect(
        (await parseRebaseLog(uFragmentsPolicy.connect(orchestrator).rebase()))
          .requestedSupplyAdjustment,
      ).to.eq(1)
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
  })

  describe('when uFragments supply equals MAX_SUPPLY and rebase attempts to grow', function () {
    before(async function () {
      await mockExternalData(MAX_SUPPLY)
      await increaseTime(60)
    })

    it('should not grow', async function () {
      expect(
        (await parseRebaseLog(uFragmentsPolicy.connect(orchestrator).rebase()))
          .requestedSupplyAdjustment,
      ).to.eq(0)
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
  })

  describe('when regular daily rebase runs', function () {
    beforeEach(async function () {
      await mockExternalData(10000)
      await uFragmentsPolicy
        .connect(deployer)
        .setRebaseTimingParameters(60, 0, 60)
      await increaseTime(60)
      await uFragmentsPolicy.connect(orchestrator).rebase()
      prevEpoch = await uFragmentsPolicy.epoch()
      prevTime = await uFragmentsPolicy.lastRebaseTimestampSec()
      await mockExternalData(20000)
      await increaseTime(60)
    })

    it('should increment epoch', async function () {
      await uFragmentsPolicy.connect(orchestrator).rebase()
      expect(await uFragmentsPolicy.epoch()).to.eq(prevEpoch.add(1))
    })

    it('should update globalUpEpochAndUPSupply', async function () {
      await uFragmentsPolicy.connect(orchestrator).rebase()
      const r = await uFragmentsPolicy.globalUpEpochAndUPSupply()
      expect(r[0]).to.eq(prevEpoch.add(1))
      expect(r[1]).to.eq('20000')
    })

    it('should update lastRebaseTimestamp', async function () {
      await uFragmentsPolicy.connect(orchestrator).rebase()
      const time = await uFragmentsPolicy.lastRebaseTimestampSec()
      expect(time.sub(prevTime)).to.gte(60)
    })

    it('should emit Rebase with positive requestedSupplyAdjustment', async function () {
      const r = uFragmentsPolicy.connect(orchestrator).rebase()
      await expect(r)
        .to.emit(uFragmentsPolicy, 'LogRebase')
        .withArgs(
          prevEpoch.add(1),
          INITIAL_RATE,
          38, // 20000 * 0.0019 (default inflation rate)
          (await parseRebaseLog(r)).timestampSec,
        )
    })

    it('should call uFrag Rebase', async function () {
      const r = uFragmentsPolicy.connect(orchestrator).rebase()
      await expect(r)
        .to.emit(mockUFragments, 'FunctionCalled')
        .withArgs('UFragments', 'rebase', uFragmentsPolicy.address)
      await expect(r)
        .to.emit(mockUFragments, 'FunctionArguments')
        .withArgs([prevEpoch.add(1)], [38]) // 20000 * 0.0019 (default inflation rate)
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  before('setup UFragmentsPolicy contract', async () => {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicyWithOpenRebaseWindow))
  })

  describe('zero rate', function () {
    before(async function () {
      await uFragmentsPolicy.connect(deployer).setInflationRate(0)
      await increaseTime(60)
    })

    it('should emit Rebase with 0 requestedSupplyAdjustment', async function () {
      expect(
        (await parseRebaseLog(uFragmentsPolicy.connect(orchestrator).rebase()))
          .requestedSupplyAdjustment,
      ).to.eq(0)
    })
  })
})

describe('UFragmentsPolicy:Rebase', async function () {
  let rbTime: BigNumber,
    rbWindow: BigNumber,
    minRebaseTimeIntervalSec: BigNumber,
    now: BigNumber,
    nextRebaseWindowOpenTime: BigNumber,
    timeToWait: BigNumber,
    lastRebaseTimestamp: BigNumber

  beforeEach('setup UFragmentsPolicy contract', async function () {
    ;({
      deployer,
      user,
      orchestrator,
      mockUFragments,
      uFragmentsPolicy,
    } = await waffle.loadFixture(mockedUpgradablePolicy))
    await uFragmentsPolicy
      .connect(deployer)
      .setRebaseTimingParameters(86400, 72000, 900)
    rbTime = await uFragmentsPolicy.rebaseWindowOffsetSec()
    rbWindow = await uFragmentsPolicy.rebaseWindowLengthSec()
    minRebaseTimeIntervalSec = await uFragmentsPolicy.minRebaseTimeIntervalSec()
    now = ethers.BigNumber.from(
      (await ethers.provider.getBlock('latest')).timestamp,
    )
    nextRebaseWindowOpenTime = now
      .sub(now.mod(minRebaseTimeIntervalSec))
      .add(rbTime)
      .add(minRebaseTimeIntervalSec)
  })

  describe('when its 5s after the rebase window closes', function () {
    it('should fail', async function () {
      timeToWait = nextRebaseWindowOpenTime.sub(now).add(rbWindow).add(5)
      await increaseTime(timeToWait)
      expect(await uFragmentsPolicy.inRebaseWindow()).to.be.false
      await expect(uFragmentsPolicy.connect(orchestrator).rebase()).to.be
        .reverted
    })
  })

  describe('when its 5s before the rebase window opens', function () {
    it('should fail', async function () {
      timeToWait = nextRebaseWindowOpenTime.sub(now).sub(5)
      await increaseTime(timeToWait)
      expect(await uFragmentsPolicy.inRebaseWindow()).to.be.false
      await expect(uFragmentsPolicy.connect(orchestrator).rebase()).to.be
        .reverted
    })
  })

  describe('when its 5s after the rebase window opens', function () {
    it('should NOT fail', async function () {
      timeToWait = nextRebaseWindowOpenTime.sub(now).add(5)
      await increaseTime(timeToWait)
      expect(await uFragmentsPolicy.inRebaseWindow()).to.be.true
      await expect(uFragmentsPolicy.connect(orchestrator).rebase()).to.not.be
        .reverted
      lastRebaseTimestamp = await uFragmentsPolicy.lastRebaseTimestampSec()
      expect(lastRebaseTimestamp).to.eq(nextRebaseWindowOpenTime)
    })
  })

  describe('when its 5s before the rebase window closes', function () {
    it('should NOT fail', async function () {
      timeToWait = nextRebaseWindowOpenTime.sub(now).add(rbWindow).sub(5)
      await increaseTime(timeToWait)
      expect(await uFragmentsPolicy.inRebaseWindow()).to.be.true
      await expect(uFragmentsPolicy.connect(orchestrator).rebase()).to.not.be
        .reverted
      lastRebaseTimestamp = await uFragmentsPolicy.lastRebaseTimestampSec.call()
      expect(lastRebaseTimestamp).to.eq(nextRebaseWindowOpenTime)
    })
  })
})
