// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title InitVault
/// @notice Demo bounty target written for this repo only. It contains a deliberate bug.
/// Never deploy it with real funds.
/// Proxy-style vault: deployed once, then configured with initialize(). Users deposit and
/// withdraw ether. The owner can pause the vault and, while paused, move all funds to a
/// recovery address (balances stay on the books so users can be made whole from there).
contract InitVault {
    address public owner;
    address public pendingOwner;
    bool public paused;
    bool private _initialized;

    mapping(address => uint256) public balances;
    uint256 public totalDeposits;
    /// @notice Maximum ether per withdrawal.
    uint256 public withdrawLimit;

    event Initialized(address indexed owner, uint256 withdrawLimit);
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Paused(bool paused);
    event EmergencyWithdrawal(address indexed to, uint256 amount);

    modifier initializer() {
        require(!_initialized, "already initialized");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    function initialize(address owner_, uint256 withdrawLimit_) external initializer {
        require(owner_ != address(0), "zero owner");
        owner = owner_;
        withdrawLimit = withdrawLimit_;
        emit Initialized(owner_, withdrawLimit_);
    }

    function deposit() external payable whenNotPaused {
        require(msg.value > 0, "zero deposit");
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external whenNotPaused {
        require(amount <= withdrawLimit, "over limit");
        uint256 bal = balances[msg.sender];
        require(bal >= amount, "insufficient balance");
        balances[msg.sender] = bal - amount;
        totalDeposits -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function setWithdrawLimit(uint256 limit) external onlyOwner {
        withdrawLimit = limit;
    }

    function emergencyWithdraw(address payable to) external onlyOwner {
        require(paused, "not paused");
        uint256 amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "transfer failed");
        emit EmergencyWithdrawal(to, amount);
    }
}
