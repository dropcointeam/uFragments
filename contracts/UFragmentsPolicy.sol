pragma solidity 0.7.6;

import "./_external/SafeMath.sol";
import "./_external/Ownable.sol";

import "./lib/SafeMathInt.sol";
import "./lib/UInt256Lib.sol";

interface IUFragments {
    function totalSupply() external view returns (uint256);

    function rebase(uint256 epoch, int256 supplyDelta) external returns (uint256);
}

interface IOracle {
    function getData() external returns (uint256, bool);
}

/**
 * @title uFragments Monetary Supply Policy
 * @dev This is an implementation of the uFragments Ideal Money protocol.
 *      uFragments ERC20 token expands daily on a set inflation rate.
 */
contract UFragmentsPolicy is Ownable {
    using SafeMath for uint256;
    using SafeMathInt for int256;
    using UInt256Lib for uint256;

    event LogRebase(
        uint256 indexed epoch,
        uint256 inflationRate,
        int256 requestedSupplyAdjustment,
        uint256 timestampSec
    );

    IUFragments public uFrags;

    // The daily inflation rate we rebase on
    // 6 DECIMALS Fixed point number.
    // (eg) An inflation rate of 1900 (APY 100%), 1 token would be rebased to 1 * (1 + 0.0019) daily
    uint256 public inflationRate;

    // More than this much time must pass between rebase operations.
    uint256 public minRebaseTimeIntervalSec;

    // Block timestamp of last rebase operation
    uint256 public lastRebaseTimestampSec;

    // The rebase window begins this many seconds into the minRebaseTimeInterval period.
    // For example if minRebaseTimeInterval is 24hrs, it represents the time of day in seconds.
    uint256 public rebaseWindowOffsetSec;

    // The length of the time window where a rebase operation is allowed to execute, in seconds.
    uint256 public rebaseWindowLengthSec;

    // The number of rebase cycles since inception
    uint256 public epoch;

    uint256 private constant DECIMALS = 6;

    // Due to the expression in computeSupplyDelta()
    // MAX_RATE * MAX_SUPPLY must fit into an int256.
    // Both are DECIMALS fixed point numbers.
    // Max inflation rate is 100%
    uint256 private constant MAX_RATE = 10**DECIMALS;

    // MAX_SUPPLY = MAX_INT256 / MAX_RATE
    uint256 private constant MAX_SUPPLY = uint256(type(int256).max) / MAX_RATE;

    // This module orchestrates the rebase execution and downstream notification.
    address public orchestrator;

    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator);
        _;
    }

    /**
     * @notice Initiates a new rebase operation, provided the minimum time period has elapsed.
     *
     * @dev The supply adjustment equals (_totalSupply * inflationRate)
     */
    function rebase() external onlyOrchestrator {
        require(inRebaseWindow());

        // This comparison also ensures there is no reentrancy.
        require(lastRebaseTimestampSec.add(minRebaseTimeIntervalSec) < block.timestamp);

        // Snap the rebase time to the start of this window.
        lastRebaseTimestampSec = block
            .timestamp
            .sub(block.timestamp.mod(minRebaseTimeIntervalSec))
            .add(rebaseWindowOffsetSec);

        epoch = epoch.add(1);

        // int256 supplyDelta = computeSupplyDelta(exchangeRate, targetRate);
        int256 supplyDelta = computeSupplyDelta();

        if (supplyDelta > 0 && uFrags.totalSupply().add(uint256(supplyDelta)) > MAX_SUPPLY) {
            supplyDelta = (MAX_SUPPLY.sub(uFrags.totalSupply())).toInt256Safe();
        }

        uint256 supplyAfterRebase = uFrags.rebase(epoch, supplyDelta);
        assert(supplyAfterRebase <= MAX_SUPPLY);
        emit LogRebase(epoch, inflationRate, supplyDelta, block.timestamp);
    }

    /**
     * @notice Sets the reference to the orchestrator.
     * @param orchestrator_ The address of the orchestrator contract.
     */
    function setOrchestrator(address orchestrator_) external onlyOwner {
        orchestrator = orchestrator_;
    }

    /**
     * @notice Sets the daily rebase inflation rate. DECIMALS fixed point number
     * @param inflationRate_ The new rebase inflation rate.
     */
    function setInflationRate(uint256 inflationRate_) external onlyOwner {
        require(inflationRate_ >= 0);
        require(inflationRate_ <= MAX_RATE);
        inflationRate = inflationRate_;
    }

    /**
     * @notice Sets the parameters which control the timing and frequency of
     *         rebase operations.
     *         a) the minimum time period that must elapse between rebase cycles.
     *         b) the rebase window offset parameter.
     *         c) the rebase window length parameter.
     * @param minRebaseTimeIntervalSec_ More than this much time must pass between rebase
     *        operations, in seconds.
     * @param rebaseWindowOffsetSec_ The number of seconds from the beginning of
              the rebase interval, where the rebase window begins.
     * @param rebaseWindowLengthSec_ The length of the rebase window in seconds.
     */
    function setRebaseTimingParameters(
        uint256 minRebaseTimeIntervalSec_,
        uint256 rebaseWindowOffsetSec_,
        uint256 rebaseWindowLengthSec_
    ) external onlyOwner {
        require(minRebaseTimeIntervalSec_ > 0);
        require(rebaseWindowOffsetSec_ < minRebaseTimeIntervalSec_);

        minRebaseTimeIntervalSec = minRebaseTimeIntervalSec_;
        rebaseWindowOffsetSec = rebaseWindowOffsetSec_;
        rebaseWindowLengthSec = rebaseWindowLengthSec_;
    }

    /**
     * @notice A multi-chain UP interface method. The Up monetary policy contract
     *         on the base-chain and XC-UpController contracts on the satellite-chains
     *         implement this method. It atomically returns two values:
     *         what the current contract believes to be,
     *         the globalUpEpoch and globalUPSupply.
     * @return globalUpEpoch The current epoch number.
     * @return globalUPSupply The total supply at the current epoch.
     */
    function globalUpEpochAndUPSupply() external view returns (uint256, uint256) {
        return (epoch, uFrags.totalSupply());
    }

    /**
     * @dev ZOS upgradable contract initialization method.
     *      It is called at the time of contract creation to invoke parent class initializers and
     *      initialize the contract's state variables.
     */
    function initialize(address owner_, IUFragments uFrags_) public initializer {
        Ownable.initialize(owner_);

        // 1*(1+0.0019)^365 ~= 100% APY
        // inflationRate = 0.0019 * 1e6 = 1900
        // Some inflation rate -> APY mapping:
        // IR  100 -> APY 3.7%
        // IR  200 -> APY 7.6%
        // IR  500 -> APY 20%
        // IR 1000 -> APY 44%
        // IR 1900 -> APY 100%
        inflationRate = 1900;
        minRebaseTimeIntervalSec = 1 days;
        rebaseWindowOffsetSec = 72000; // 8PM UTC
        rebaseWindowLengthSec = 15 minutes;
        lastRebaseTimestampSec = 0;
        epoch = 0;

        uFrags = uFrags_;
    }

    /**
     * @return If the latest block timestamp is within the rebase time window it, returns true.
     *         Otherwise, returns false.
     */
    function inRebaseWindow() public view returns (bool) {
        return (block.timestamp.mod(minRebaseTimeIntervalSec) >= rebaseWindowOffsetSec &&
            block.timestamp.mod(minRebaseTimeIntervalSec) <
            (rebaseWindowOffsetSec.add(rebaseWindowLengthSec)));
    }

    /**
     * @return Computes the total supply adjustment based on inflationRate
     */
    function computeSupplyDelta() internal view returns (int256) {
        // supplyDelta = totalSupply * inflationRate
        return (uFrags.totalSupply().mul(inflationRate).div(10**DECIMALS)).toInt256Safe();
    }
}
